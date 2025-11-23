import ChatRequest from "../../models/ChatRequest.js";
import User from "../../models/User.js";
import Post from "../../models/Post.js";
import { asyncHandler } from "../../utils/errorHandler.js";
import { errorResponse, successResponse } from "../../utils/response.js";
import { getIO } from "../../config/socket.js";
import Notification from "../../models/Notification.js";
import { sendFirebaseNotification } from "../../utils/firebaseHelper.js";
import mongoose from "mongoose";
import redisClient from "../../config/redis.js";
import ChatConversation from "../../models/ChatConversation.js";
import { checkUserDeleted } from "../../utils/chatHelper.js";
// ... other imports

// Helper function to delete Redis keys by pattern
const deleteRedisKeysByPattern = async (pattern) => {
  if (!redisClient || typeof redisClient.scan !== "function") return;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = nextCursor;
      if (Array.isArray(keys) && keys.length > 0) {
        await redisClient.del(...keys);
      }
    } while (cursor !== "0");
  } catch (err) {
    console.warn(`Redis delete failed for pattern ${pattern}:`, err.message);
  }
};

export const sendChatRequest = asyncHandler(async (req, res) => {
  const senderId = req.user?.id;
  const { postId } = req.body;

  if (!senderId) return errorResponse(res, "Unauthorized", 401);
  if (!postId) return errorResponse(res, "postId is required", 400);

  // ✅ Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return errorResponse(res, "Post id not found", 404);
  }

  const post = await Post.findById(postId).populate({ path: "author", select: "_id" });
  if (!post) return errorResponse(res, "Post id not found", 404);

  const receiverId = post.author?._id?.toString();
  if (!receiverId)
    return errorResponse(res, "Receiver user not found for post", 404);
  if (String(senderId) === String(receiverId))
    return errorResponse(res, "You cannot send request to your own user", 400);

  const sender = req.user;
  const receiver = await User.findById(receiverId).select(
    "firstname lastname email isSubscription isAdmin fcmToken"
  );
  if (!receiver) return errorResponse(res, "Receiver not found", 404);

  // ✅ FIX: Check ONLY current user (sender) subscription
  if (!sender) return errorResponse(res, "Sender not found", 404);

  const senderAllowed = !!(sender.isSubscription || sender.isAdmin);

  // ✅ FIX: Only check sender subscription, NOT receiver
  if (!senderAllowed) {
    return errorResponse(
      res,
      "You must have an active subscription (or be an admin) to send chat requests",
      403
    );
  }

  const chatType = "individual";
  const existing = await ChatRequest.findOne({
    senderId,
    receiverId,
    chatType,
    status: "pending",
  });

  if (existing)
    return errorResponse(res, "A pending request already exists", 409);

  const request = await ChatRequest.create({ senderId, receiverId, chatType });

  const populated = await request.populate([
    { path: "senderId", select: "firstname lastname email profileimg" },
    { path: "receiverId", select: "firstname lastname email profileimg" },
  ]);

  // ✅ SOCKET EVENT
  try {
    const io = getIO();
    const payload = {
      _id: String(populated._id),
      senderId: populated.senderId,
      receiverId: populated.receiverId,
      chatType: populated.chatType,
      status: populated.status,
      createdAt: populated.createdAt,
    };
    io.to(`user:${receiverId}`).emit("chatRequest:received", payload);
    io.to(`user:${receiverId}`).emit("chatRequests:update");
    console.log(`📩 Chat request sent & socket event emitted to user ${receiverId}`);
  } catch (err) {
    console.error("Socket emit error (new request):", err.message);
  }

  // ✅ Clear receiver cache
  try {
    await redisClient.del([`requests:${String(receiverId)}:received`]);
  } catch (err) {
    console.warn("Redis clear error:", err.message);
  }

  // ✅ Create and send notification
  try {
    const title = "Receive new request!";
    const senderForNotification = await User.findById(senderId).select("firstname lastname email");
    console.log("Sender info for notification:", senderForNotification.firstname, senderForNotification.lastname);
    const senderName = `${senderForNotification.firstname || ""} ${senderForNotification.lastname || ""}`.trim() || senderForNotification.email;
    const message = `${senderName} wants to start a chat with you.`;

    // 1️⃣ Save to DB
    const notification = await Notification.create({
      userId: receiverId,
      title,
      message,
      deeplink: "",
    });

    // 2️⃣ Send Firebase push
    if (receiver.fcmToken) {
      const pushResult = await sendFirebaseNotification(
        receiver.fcmToken,
        title,
        message,
        { type: "chat_request", senderId: senderId.toString(), deeplink: "" }
      );

      notification.firebaseStatus = pushResult.success ? "sent" : "failed";
      await notification.save();

      if (pushResult.success) {
        console.log(`✅ Firebase notification sent to ${receiver.email}`);
      } else {
        console.error(`⚠️ Firebase send failed: ${pushResult.error}`);

        // If token is invalid, clear it from user record
        if (pushResult.error.includes('invalid-registration-token')) {
          console.log("🔄 Clearing invalid FCM token from user record");
          await User.findByIdAndUpdate(receiverId, { $unset: { fcmToken: 1 } });
        }
      }
    } else {
      console.warn(`⚠️ Receiver has no FCM token, skipping push notification`);
    }
  } catch (err) {
    console.error("❌ Error in notification process:", err.message);
  }

  // ✅ Final response
  const obj = populated.toObject();
  const filtered = {
    _id: obj._id,
    senderId: obj.senderId,
    receiverId: obj.receiverId,
    chatType: obj.chatType,
    status: obj.status,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };

  return successResponse(res, "Chat request sent", filtered, null, 200, 1);
});

export const actOnChatRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'accept' or 'reject'
  const userId = req.user?.id;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return errorResponse(res, "Invalid chat request ID", 400);
  }

  if (!["accept", "reject"].includes(action)) {
    return errorResponse(res, "Action must be 'accept' or 'reject'", 400);
  }

  const request = await ChatRequest.findById(id);
  if (!request) {
    return errorResponse(res, "Chat request not found", 404);
  }

  if (String(request.receiverId) !== String(userId)) {
    return errorResponse(res, "Only the receiver can act on this request", 403);
  }

  const sender = await User.findById(request.senderId).select("firstname lastname email fcmToken isSubscription isAdmin");
  const receiver = await User.findById(request.receiverId).select("firstname lastname email fcmToken isSubscription isAdmin");

  if (!sender || !receiver) {
    return errorResponse(res, "User not found", 404);
  }

  // ✅ FIX: Check ONLY current user (receiver) subscription
  const receiverAllowed = !!(receiver.isSubscription || receiver.isAdmin);

  // ✅ FIX: Only check receiver subscription, NOT sender
  if (!receiverAllowed) {
    return errorResponse(
      res,
      "You must have an active subscription (or be an admin) to accept/reject chat requests",
      403
    );
  }

  const receiverName =
    `${receiver.firstname || ""} ${receiver.lastname || ""}`.trim() || receiver.email;

  // ===========================================================
  // 🔸 REJECT FLOW
  // ===========================================================
  if (action === "reject") {
    await ChatRequest.findByIdAndDelete(id);

    try {
      const io = getIO();
      const payload = {
        _id: String(id),
        senderId: String(request.senderId),
        receiverId: String(request.receiverId),
        status: "rejected",
      };

      io.to(`user:${request.senderId}`).emit("chatRequest:rejected", payload);
      io.to(`user:${request.receiverId}`).emit("chatRequest:rejected", payload);
      io.to(`user:${request.senderId}`).emit("chatRequests:update");
      io.to(`user:${request.receiverId}`).emit("chatRequests:update");

      console.log(`🚫 Chat request rejected for ${id}`);
    } catch (err) {
      console.error("Socket emit error (rejected):", err.message);
    }

    // Redis clear - use pattern matching to clear all cache keys with pagination/search params
    try {
      const patterns = [
        `requests:${String(request.senderId)}:received:*`,
        `requests:${String(request.senderId)}:sent:*`,
        `requests:${String(request.senderId)}:accepted:*`,
        `requests:${String(request.receiverId)}:received:*`,
        `requests:${String(request.receiverId)}:sent:*`,
        `requests:${String(request.receiverId)}:accepted:*`,
      ];
      
      // Also clear exact keys without pagination (for backward compatibility)
      const exactKeys = [
        `requests:${String(request.senderId)}:received`,
        `requests:${String(request.senderId)}:sent`,
        `requests:${String(request.senderId)}:accepted`,
        `requests:${String(request.receiverId)}:received`,
        `requests:${String(request.receiverId)}:sent`,
        `requests:${String(request.receiverId)}:accepted`,
      ];
      
      await Promise.all([
        ...patterns.map(pattern => deleteRedisKeysByPattern(pattern)),
        redisClient.del(exactKeys)
      ]);
    } catch (err) {
      console.warn("Redis clear error:", err.message);
    }

    // Notification for reject
    try {
      const title = "Request Rejected";
      const message = `${receiverName} has rejected your chat or group invitation.`;

      const notification = await Notification.create({
        userId: sender._id,
        title,
        message,
        deeplink: "",
      });

      console.log(`🔔 Notification created for reject ${sender._id}: ${notification}`);

      if (sender.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          sender.fcmToken,
          title,
          message,
          { type: "chat_request_reject", senderId: receiver._id.toString(), deeplink: "" }
        );

        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }
    } catch (err) {
      console.error("❌ Error sending reject notification:", err.message);
    }

    return successResponse(res, "Chat request rejected successfully", null, null, 200, 1);
  }

  // ===========================================================
  // 🔸 ACCEPT FLOW
  // ===========================================================
  // ✅ Check if already accepted to prevent duplicate processing
  if (request.status === "accepted") {
    return successResponse(res, "Chat request already accepted", request, null, 200, 1);
  }

  request.status = "accepted";
  await request.save();

  // ✅ If this is a group invitation, add receiver to group's members
  if (request.chatType === "group" && request.groupId) {
    const groupRoot = await ChatRequest.findOne({
      _id: request.groupId,
      chatType: "group",
      receiverId: null,
    });

    if (groupRoot) {
      const memberStrIds = (groupRoot.members || []).map(m => String(m));
      if (!memberStrIds.includes(String(userId))) {
        groupRoot.members.push(userId);
        await groupRoot.save();

        console.log(`✅ User ${userId} added to group ${groupRoot._id} on acceptance`);

        // Record join time for the new member
        try {
          await ChatConversation.findOneAndUpdate(
            { chatRequestId: groupRoot._id },
            {
              $set: {
                [`joinedAtByUser.${String(userId)}`]: new Date()
              },
              $setOnInsert: { chatType: "group" },
              $addToSet: { participants: String(userId) }
            },
            { upsert: true }
          );
        } catch (err) {
          console.warn("⚠️ Failed to record join time for accepted member:", err.message);
        }

        // Emit socket event to group members
        try {
          const io = getIO();
          io.to(`chat:${String(groupRoot._id)}`).emit("group:memberJoined", {
            groupId: String(groupRoot._id),
            newMember: {
              _id: receiver._id,
              firstname: receiver.firstname,
              lastname: receiver.lastname,
              email: receiver.email,
              profileimg: receiver.profileimg,
            },
          });
        } catch (err) {
          console.error("Socket emit error (group join):", err.message);
        }

        // Optional: send notification to group admin
        try {
          const groupAdmin = await User.findById(groupRoot.groupAdmin).select("fcmToken email firstname lastname");
          if (groupAdmin?.fcmToken) {
            const title = "New Member Joined";
            const message = `${receiverName} has joined your group “${groupRoot.name}”.`;
            await sendFirebaseNotification(groupAdmin.fcmToken, title, message, {
              type: "group_member_join",
              groupId: String(groupRoot._id),
              memberId: String(receiver._id),
            });
          }
        } catch (err) {
          console.warn("Notification error (group admin):", err.message);
        }
      }
    }
  }

  // Redis clear - use pattern matching to clear all cache keys with pagination/search params
  // ✅ Clear cache BEFORE emitting socket events to ensure fresh data
  try {
    const patterns = [
      `requests:${String(request.senderId)}:received:*`,
      `requests:${String(request.senderId)}:sent:*`,
      `requests:${String(request.senderId)}:accepted:*`,
      `requests:${String(request.receiverId)}:received:*`,
      `requests:${String(request.receiverId)}:sent:*`,
      `requests:${String(request.receiverId)}:accepted:*`,
    ];
    
    // Also clear exact keys without pagination (for backward compatibility)
    const exactKeys = [
      `requests:${String(request.senderId)}:received`,
      `requests:${String(request.senderId)}:sent`,
      `requests:${String(request.senderId)}:accepted`,
      `requests:${String(request.receiverId)}:received`,
      `requests:${String(request.receiverId)}:sent`,
      `requests:${String(request.receiverId)}:accepted`,
    ];
    
    await Promise.all([
      ...patterns.map(pattern => deleteRedisKeysByPattern(pattern)),
      redisClient.del(exactKeys)
    ]);
    console.log(`✅ Cache cleared for sender ${request.senderId} and receiver ${request.receiverId}`);
  } catch (err) {
    console.warn("Redis clear error:", err.message);
  }

  // ✅ Get fresh populated request after cache clear and save
  const populated = await ChatRequest.findById(request._id).populate([
    { path: "senderId", select: "firstname lastname email profileimg" },
    { path: "receiverId", select: "firstname lastname email profileimg" },
    { path: "groupId" },
  ]);

  if (!populated) {
    return errorResponse(res, "Failed to fetch updated request", 500);
  }
  
  // Ensure populated request has the accepted status
  populated.status = "accepted";

  // Emit socket updates
  try {
    const io = getIO();
    const payload = {
      _id: String(request._id),
      senderId: String(request.senderId),
      receiverId: String(request.receiverId),
      status: "accepted",
      chatType: request.chatType,
      groupId: request.groupId ? String(request.groupId) : null,
    };

    io.to(`user:${request.senderId}`).emit("chatRequest:accepted", payload);
    io.to(`user:${request.receiverId}`).emit("chatRequest:accepted", payload);
    io.to(`user:${request.senderId}`).emit("chatRequests:update");
    io.to(`user:${request.receiverId}`).emit("chatRequests:update");

    // ✅ NEW: Emit specific chatList:update events to update tabs
    // Format the populated request for accepted tab
    const formattedRequest = populated.toObject ? populated.toObject() : populated;
    
    // Add partnerInfo for individual chats
    if (formattedRequest.chatType === "individual") {
      // For receiver: partner is sender
      formattedRequest.partnerInfo = formattedRequest.senderId;
      // For sender: partner is receiver
      const senderFormattedRequest = { ...formattedRequest };
      senderFormattedRequest.partnerInfo = formattedRequest.receiverId;
      
      // Emit to RECEIVER: Remove from "received" tab, Add to "accepted" tab
      io.to(`user:${request.receiverId}`).emit("chatList:update", {
        type: "received",
        action: "removed",
        chatId: String(request._id),
        chatRequest: formattedRequest
      });
      io.to(`user:${request.receiverId}`).emit("chatList:update", {
        type: "accepted",
        action: "added",
        chatId: String(request._id),
        chatRequest: formattedRequest
      });

      // Emit to SENDER: Remove from "sent" tab, Add to "accepted" tab
      io.to(`user:${request.senderId}`).emit("chatList:update", {
        type: "sent",
        action: "removed",
        chatId: String(request._id),
        chatRequest: senderFormattedRequest
      });
      io.to(`user:${request.senderId}`).emit("chatList:update", {
        type: "accepted",
        action: "added",
        chatId: String(request._id),
        chatRequest: senderFormattedRequest
      });
    }

    console.log(`✅ Chat request accepted - socket events emitted to sender ${request.senderId} and receiver ${request.receiverId}`);
  } catch (err) {
    console.error("Socket emit error (accepted):", err.message);
    // Don't fail the request if socket emit fails, but log it
  }

  // Send notification
  try {
    const title = "Request Accepted";
    const message =
      request.chatType === "group"
        ? `${receiverName} has accepted your group invitation.`
        : `${receiverName} has accepted your chat request.`;

    const notification = await Notification.create({
      userId: sender._id,
      title,
      message,
      deeplink: "",
    });

    console.log(`🔔 Notification created for accept ${sender._id}: ${notification}`);

    if (sender.fcmToken) {
      const pushResult = await sendFirebaseNotification(
        sender.fcmToken,
        title,
        message,
        { type: "chat_request_accept", senderId: receiver._id.toString(), deeplink: "" }
      );

      notification.firebaseStatus = pushResult.success ? "sent" : "failed";
      await notification.save();
    }
  } catch (err) {
    console.error("❌ Error sending accept notification:", err.message);
  }

  return successResponse(res, "Chat request accepted successfully", populated, null, 200, 1);
});

export const getMyReceivedRequests = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  // ✅ ADD: Check user subscription
  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return errorResponse(res, "User not found", 404);

  const userAllowed = !!(user.isSubscription || user.isAdmin);
  if (!userAllowed) {
    return errorResponse(
      res,
      "You must have an active subscription (or be an admin) to view chat requests",
      403
    );
  }

  const requests = await ChatRequest.find({ receiverId: userId, status: "pending" })
    .populate([
      { path: "senderId", select: "firstname lastname email" },
      { path: "receiverId", select: "firstname lastname email" }
    ])
    .sort({ createdAt: -1 });
  return successResponse(res, "Pending received requests", requests, null, 200, 1);
});

export const getMySentRequests = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  // ✅ ADD: Check user subscription
  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return errorResponse(res, "User not found", 404);

  const userAllowed = !!(user.isSubscription || user.isAdmin);
  if (!userAllowed) {
    return errorResponse(
      res,
      "You must have an active subscription (or be an admin) to view chat requests",
      403
    );
  }

  const requests = await ChatRequest.find({ senderId: userId, status: "pending" })
    .populate([
      { path: "senderId", select: "firstname lastname email" },
      { path: "receiverId", select: "firstname lastname email" }
    ])
    .sort({ createdAt: -1 });
  return successResponse(res, "Pending sent requests", requests, null, 200, 1);
});

export const getMyAcceptedRequests = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  // ✅ ADD: Check user subscription
  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return errorResponse(res, "User not found", 404);

  const userAllowed = !!(user.isSubscription || user.isAdmin);
  if (!userAllowed) {
    return errorResponse(
      res,
      "You must have an active subscription (or be an admin) to view chat requests",
      403
    );
  }

  const requests = await ChatRequest.find({
    status: "accepted",
    $or: [{ senderId: userId }, { receiverId: userId }]
  })
    .populate([
      { path: "senderId", select: "firstname lastname email" },
      { path: "receiverId", select: "firstname lastname email" },
      { path: "groupId" }
    ])
    .sort({ updatedAt: -1, createdAt: -1 });
  return successResponse(res, "Accepted requests", requests, null, 200, 1);
});

export const getRequestsByType = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { type } = req.query; // 'received' | 'sent' | 'accepted' | 'group'
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search ? req.query.search.trim() : "";
  const skip = (page - 1) * limit;

  if (!type || !["received", "sent", "accepted", "group"].includes(type)) {
    return errorResponse(res, "type must be one of: received, sent, accepted, group", 404);
  }

  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return errorResponse(res, "User not found", 404);

  const pickLastVisibleMessageForUser = (conversation) => {
    if (!conversation || !Array.isArray(conversation.messages)) {
      return { lastMessage: null, lastMessageTimestamp: null };
    }

    const userAllowed = !!(user.isSubscription || user.isAdmin);
    if (!userAllowed) {
      return errorResponse(
        res,
        "You must have an active subscription (or be an admin) to view chat requests",
        403
      );
    }

    const deletedForCurrentUser = new Set();
    if (Array.isArray(conversation.deletedForMe)) {
      conversation.deletedForMe.forEach((deletion) => {
        if (
          deletion?.userId &&
          deletion?.messageId &&
          String(deletion.userId) === String(userId)
        ) {
          deletedForCurrentUser.add(String(deletion.messageId));
        }
      });
    }

    let joinedAtDate = null;
    if (conversation.joinedAtByUser) {
      const joinedEntry = typeof conversation.joinedAtByUser.get === "function"
        ? conversation.joinedAtByUser.get(String(userId))
        : conversation.joinedAtByUser[String(userId)];
      if (joinedEntry) {
        joinedAtDate = new Date(joinedEntry);
      }
    }

    // ✅ FIXED: Find the last visible message (same logic as before)
    for (let idx = conversation.messages.length - 1; idx >= 0; idx -= 1) {
      const msg = conversation.messages[idx];
      if (!msg) continue;

      const msgIdStr = String(msg._id);
      const rawSenderId = msg.sender?._id ? msg.sender._id : msg.sender;
      const senderIdStr = rawSenderId ? String(rawSenderId) : null;

      // Skip if message is deleted
      if (msg.isDeleteEvery === true) continue;
      if (deletedForCurrentUser.has(msgIdStr)) continue;
      if (joinedAtDate && new Date(msg.createdAt) < joinedAtDate) continue;

      const senderInfo = msg.sender?._id
        ? {
          _id: String(msg.sender._id),
          firstname: msg.sender.firstname,
          lastname: msg.sender.lastname,
          email: msg.sender.email,
          profileimg: msg.sender.profileimg,
        }
        : msg.sender
          ? {
            _id: String(msg.sender),
          }
          : null;

      const isCurrentUserSender = senderIdStr && String(senderIdStr) === String(userId);

      return {
        lastMessage: {
          _id: msgIdStr,
          chatRequestId: conversation.chatRequestId
            ? String(conversation.chatRequestId)
            : null,
          content: msg.content,
          mediaUrl: msg.mediaUrl || null,
          messageType: msg.messageType || "text",
          sender: senderInfo,
          createdAt: msg.createdAt,
          deletedFor: msg.deletedFor || null,
          isDeleteEvery: msg.isDeleteEvery === true,
          type: isCurrentUserSender ? "send" : "receive",
        },
        lastMessageTimestamp: msg.createdAt ? new Date(msg.createdAt) : null,
      };
    }

    return { lastMessage: null, lastMessageTimestamp: null };
  };

  // ========== GROUP CHAT HANDLING (EXISTING CODE - NO CHANGES) ==========
  if (type === "group") {
    const cacheKey = `requests:${String(userId)}:group:page:${page}:limit:${limit}:search:${search}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return successResponse(res, parsed.message, parsed.data, parsed.pagination, 200, 1);
    }

    let groupQuery = {
      chatType: 'group',
      receiverId: null,
      $or: [
        { groupAdmin: userId },
        { superAdmins: userId },
        { members: userId }
      ]
    };

    if (search) {
      groupQuery.name = { $regex: search, $options: "i" };
    }

    const totalGroups = await ChatRequest.countDocuments(groupQuery);
    const groups = await ChatRequest.find(groupQuery)
      .populate([
        { path: "groupAdmin", select: "firstname lastname email profileimg isDeleted" },
        { path: "superAdmins", select: "firstname lastname email profileimg isDeleted" },
        { path: "members", select: "firstname lastname email profileimg isDeleted" }
      ])
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit);

    // ✅ Remove deleted users from groups automatically and filter out groups with deleted admins
    const validGroups = [];
    for (const group of groups) {
      // ✅ If groupAdmin is deleted, the group should have been deleted automatically
      // This check is just a safety net - if we find a deleted admin, skip this group
      if (group.groupAdmin && group.groupAdmin.isDeleted === true) {
        console.warn(`⚠️ Found group ${group._id} with deleted admin - should have been deleted. Skipping.`);
        continue; // Skip this group
      }

      // Filter deleted users from members
      if (group.members && Array.isArray(group.members)) {
        const deletedMemberIds = [];
        group.members = group.members.filter(member => {
          if (member && member.isDeleted === true) {
            deletedMemberIds.push(String(member._id));
            return false;
          }
          return true;
        });

        // If deleted users were found, remove them from the group
        if (deletedMemberIds.length > 0) {
          const deletedObjectIds = deletedMemberIds.map(id =>
            mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
          );
          await ChatRequest.findByIdAndUpdate(group._id, {
            $pull: { members: { $in: deletedObjectIds } }
          });
          // Also remove from superAdmins if they were there
          await ChatRequest.findByIdAndUpdate(group._id, {
            $pull: { superAdmins: { $in: deletedObjectIds } }
          });
        }
      }

      // Filter deleted users from superAdmins
      if (group.superAdmins && Array.isArray(group.superAdmins)) {
        const deletedAdminIds = [];
        group.superAdmins = group.superAdmins.filter(admin => {
          if (admin && admin.isDeleted === true) {
            deletedAdminIds.push(String(admin._id));
            return false;
          }
          return true;
        });

        if (deletedAdminIds.length > 0) {
          const deletedObjectIds = deletedAdminIds.map(id =>
            mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
          );
          await ChatRequest.findByIdAndUpdate(group._id, {
            $pull: { superAdmins: { $in: deletedObjectIds } }
          });
        }
      }

      validGroups.push(group);
    }

    // Replace groups array with valid groups only
    groups.length = 0;
    groups.push(...validGroups);

    const groupIds = groups.map(g => g._id.toString());
    const conversations = await ChatConversation.find({ chatRequestId: { $in: groupIds } })
      .populate({ path: "messages.sender", select: "firstname lastname email profileimg" });
    const convoMap = new Map(conversations.map(c => [c.chatRequestId.toString(), c]));

    const data = groups.map(g => {
      const creatorIdStr = g.groupAdmin?._id?.toString();
      const adminIdSet = new Set((g.superAdmins || []).map(a => a._id.toString()));
      const filteredMembers = (g.members || []).filter(m => {
        if (!m) return false;
        // Filter out deleted users
        if (m.isDeleted === true) return false;
        const mid = m._id.toString();
        return mid !== creatorIdStr && !adminIdSet.has(mid);
      });

      const allUniqueUserIds = new Set();
      if (g.groupAdmin?._id && !g.groupAdmin.isDeleted) allUniqueUserIds.add(g.groupAdmin._id.toString());
      (g.superAdmins || []).forEach((a) => { if (a._id && !a.isDeleted) allUniqueUserIds.add(a._id.toString()); });
      (g.members || []).forEach((m) => { if (m._id && !m.isDeleted) allUniqueUserIds.add(m._id.toString()); });

      const membersCount = allUniqueUserIds.size;
      const obj = g.toObject();
      if (obj.messages) delete obj.messages;
      obj.membersCount = membersCount;
      obj.isOwner = creatorIdStr === String(userId);
      obj.members = filteredMembers;
      obj.groupImage = g.groupImage || null;
      obj.lastMessage = null;
      obj.lastMessageTimestamp = obj.updatedAt || obj.createdAt;

      let unreadCount = 0;
      const pendingMembers = [];

      try {
        const convo = convoMap.get(g._id.toString());
        if (convo && Array.isArray(convo.messages)) {
          const deletedForCurrentUser = new Set();
          if (Array.isArray(convo.deletedForMe)) {
            convo.deletedForMe.forEach((deletion) => {
              if (
                deletion?.userId &&
                deletion?.messageId &&
                String(deletion.userId) === String(userId)
              ) {
                deletedForCurrentUser.add(String(deletion.messageId));
              }
            });
          }

          const allUserIds = Array.from(allUniqueUserIds);
          const joinedAtByUser = convo.joinedAtByUser;

          for (const uid of allUserIds) {
            const lastReadAt = convo.lastReadAtByUser?.get?.(String(uid)) || convo.lastReadAtByUser?.[String(uid)];
            const joinedAtEntry = joinedAtByUser
              ? (typeof joinedAtByUser.get === "function"
                ? joinedAtByUser.get(String(uid))
                : joinedAtByUser[String(uid)])
              : null;
            const joinedAtDate = joinedAtEntry ? new Date(joinedAtEntry) : null;
            let count = 0;

            if (lastReadAt) {
              const lastReadDate = new Date(lastReadAt);
              count = convo.messages.reduce((acc, m) => {
                if (!m) return acc;

                const msgIdStr = String(m._id);
                const msgDate = new Date(m.createdAt);

                // Skip if message is deleted
                if (m.isDeleteEvery === true) return acc;
                if (deletedForCurrentUser.has(msgIdStr)) return acc;
                if (joinedAtDate && msgDate < joinedAtDate) return acc;

                // ✅ FIX: Only count if message is after last read time
                return acc + (msgDate > lastReadDate ? 1 : 0);
              }, 0);
            } else {
              // If no lastReadAt, count all visible messages as unread
              count = convo.messages.reduce((acc, m) => {
                if (!m) return acc;

                const msgIdStr = String(m._id);
                const msgDate = new Date(m.createdAt);

                // Skip if message is deleted
                if (m.isDeleteEvery === true) return acc;
                if (deletedForCurrentUser.has(msgIdStr)) return acc;
                if (joinedAtDate && msgDate < joinedAtDate) return acc;

                return acc + 1;
              }, 0);
            }

            if (String(uid) === String(userId)) unreadCount = count;
            if (count > 0) pendingMembers.push({ userId: uid, count });
          }

          const { lastMessage, lastMessageTimestamp } = pickLastVisibleMessageForUser(convo);
          obj.lastMessage = lastMessage;
          obj.lastMessageTimestamp = lastMessageTimestamp || obj.updatedAt || obj.createdAt;
        }
      } catch (err) {
        console.error("Error computing unread count:", err);
      }

      obj.unreadCount = unreadCount;
      obj.pendingMembers = pendingMembers.map(pm => ({
        userId: pm.userId,
        // count: pm.count > 9 ? "9+" : pm.count,
        count: pm.count,
      }));

      return obj;
    });

    const pagination = {
      currentPage: page,
      totalPages: Math.ceil(totalGroups / limit),
      totalItems: totalGroups,
      itemsPerPage: limit,
    };

    const responseData = { message: "Groups", data, pagination };
    try { await redisClient.setEx(cacheKey, 60, JSON.stringify(responseData)); } catch { }

    // ✅ EMIT SOCKET EVENT FOR GROUP LIST UPDATE
    try {
      const io = getIO();
      io.to(`user:${userId}`).emit("chatList:update", {
        type: "group",
        action: "listFetched",
        data: data,
        pagination: pagination
      });
      console.log(`📡 Group list socket event emitted to user ${userId}`);
    } catch (err) {
      console.error("Socket emit error (group list):", err.message);
    }

    return successResponse(res, "Groups", data, pagination, 200, 1);
  }

  // ========== INDIVIDUAL CHAT HANDLING (ENHANCED WITH AUTO-REORDERING) ==========
  let filter = {};
  if (type === "received") {
    filter = { receiverId: userId, status: "pending" };
  } else if (type === "sent") {
    filter = { senderId: userId, status: "pending" };
  } else if (type === "accepted") {
    filter = {
      chatType: "individual",
      status: "accepted",
      $or: [{ senderId: userId }, { receiverId: userId }]
    };
  }

  const cacheKey = `requests:${String(userId)}:${type}:page:${page}:limit:${limit}:search:${search}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    return successResponse(res, parsed.message, parsed.data, parsed.pagination, 200, 1);
  }

  let requests = await ChatRequest.find(filter)
    .populate([
      { path: "senderId", select: "firstname lastname email profileimg isDeleted" },
      { path: "receiverId", select: "firstname lastname email profileimg isDeleted" },
      { path: "groupId" }
    ])
    .sort(type === "accepted" ? { updatedAt: -1, createdAt: -1 } : { createdAt: -1 });

  // ✅ Handle deleted users for individual chats
  for (const req of requests) {
    if (req.chatType === 'individual') {
      // Check sender
      if (req.senderId && req.senderId.isDeleted === true) {
        req.senderId = {
          _id: String(req.senderId._id),
          firstname: "Profile",
          lastname: "Deleted",
          email: "",
          profileimg: "/uploads/default.png",
          isDeleted: true
        };
      }
      // Check receiver
      if (req.receiverId && req.receiverId.isDeleted === true) {
        req.receiverId = {
          _id: String(req.receiverId._id),
          firstname: "Profile",
          lastname: "Deleted",
          email: "",
          profileimg: "/uploads/default.png",
          isDeleted: true
        };
      }
    }
  }

  // Apply search filter
  if (search) {
    requests = requests.filter(req => {
      const sender = req.senderId;
      const receiver = req.receiverId;
      const searchLower = search.toLowerCase();

      const senderMatch = sender && (
        (sender.firstname && sender.firstname.toLowerCase().includes(searchLower)) ||
        (sender.lastname && sender.lastname.toLowerCase().includes(searchLower)) ||
        (sender.email && sender.email.toLowerCase().includes(searchLower)) ||
        (`${sender.firstname || ''} ${sender.lastname || ''}`.trim().toLowerCase().includes(searchLower))
      );

      const receiverMatch = receiver && (
        (receiver.firstname && receiver.firstname.toLowerCase().includes(searchLower)) ||
        (receiver.lastname && receiver.lastname.toLowerCase().includes(searchLower)) ||
        (receiver.email && receiver.email.toLowerCase().includes(searchLower)) ||
        (`${receiver.firstname || ''} ${receiver.lastname || ''}`.trim().toLowerCase().includes(searchLower))
      );

      return senderMatch || receiverMatch;
    });
  }

  const totalRequests = requests.length;

  // ✅ ENHANCED: AUTO-REORDERING FOR ACCEPTED CHATS
  if (type === "accepted") {
    const chatIds = requests
      .filter(req => req.chatType === 'individual')
      .map(req => req._id.toString());

    if (chatIds.length > 0) {
      // Fetch conversations for all chats
      const conversations = await ChatConversation.find({
        chatRequestId: { $in: chatIds }
      }).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg' });

      const convoMap = new Map(conversations.map(c => [c.chatRequestId.toString(), c]));

      // Enhance all requests with conversation data
      requests = requests.map(req => {
        const obj = req.toObject ? req.toObject() : req;

        if (obj.chatType === 'individual') {
          // ✅ Check and handle deleted users
          if (obj.senderId && obj.senderId.isDeleted === true) {
            obj.senderId = {
              _id: String(obj.senderId._id),
              firstname: "Profile",
              lastname: "Deleted",
              email: "",
              profileimg: "/uploads/default.png",
              isDeleted: true
            };
          }
          if (obj.receiverId && obj.receiverId.isDeleted === true) {
            obj.receiverId = {
              _id: String(obj.receiverId._id),
              firstname: "Profile",
              lastname: "Deleted",
              email: "",
              profileimg: "/uploads/default.png",
              isDeleted: true
            };
          }

          if (type === "accepted" && obj.chatType === "individual") {
            // Determine who is the partner (the other user in the chat)
            const isCurrentUserSender = String(obj.senderId._id) === String(userId);
            obj.partnerInfo = isCurrentUserSender ? obj.receiverId : obj.senderId;
          }


          let unreadCount = 0;
          let lastMessage = null;
          let lastMessageTimestamp = null;

          try {
            const convo = convoMap.get(obj._id.toString());
            if (convo && Array.isArray(convo.messages)) {
              const lastReadAt =
                convo.lastReadAtByUser?.get?.(String(userId)) ||
                convo.lastReadAtByUser?.[String(userId)];

              const deletedForCurrentUser = new Set();
              if (Array.isArray(convo.deletedForMe)) {
                convo.deletedForMe.forEach((deletion) => {
                  if (
                    deletion?.userId &&
                    deletion?.messageId &&
                    String(deletion.userId) === String(userId)
                  ) {
                    deletedForCurrentUser.add(String(deletion.messageId));
                  }
                });
              }

              // ✅ FIXED: Calculate unread count correctly (only messages after lastReadAt)
              if (lastReadAt) {
                const lastReadDate = new Date(lastReadAt);
                unreadCount = convo.messages.reduce((acc, m) => {
                  if (!m) return acc;

                  const msgIdStr = String(m._id);
                  const msgDate = new Date(m.createdAt);

                  // Skip if message is deleted
                  if (m.isDeleteEvery === true) return acc;
                  if (deletedForCurrentUser.has(msgIdStr)) return acc;

                  // ✅ FIX: Only count if message is after last read time
                  return acc + (msgDate > lastReadDate ? 1 : 0);
                }, 0);
              } else {
                // If no lastReadAt, count all visible messages as unread
                unreadCount = convo.messages.reduce((acc, m) => {
                  if (!m) return acc;

                  const msgIdStr = String(m._id);
                  const msgDate = new Date(m.createdAt);

                  // Skip if message is deleted
                  if (m.isDeleteEvery === true) return acc;
                  if (deletedForCurrentUser.has(msgIdStr)) return acc;

                  return acc + 1;
                }, 0);
              }

              // ✅ Get last message and timestamp for sorting
              const { lastMessage: visibleLastMessage, lastMessageTimestamp: visibleLastTs } =
                pickLastVisibleMessageForUser(convo);
              lastMessage = visibleLastMessage;
              lastMessageTimestamp = visibleLastTs;
            }
          } catch (err) {
            console.error("Error computing chat data for individual chat:", err);
          }

          // ✅ Add enhanced fields to response
          obj.unreadCount = unreadCount;
          obj.lastMessage = lastMessage;
          obj.lastMessageTimestamp = lastMessageTimestamp || obj.updatedAt || obj.createdAt;
        }

        return obj;
      });

      // ✅ AUTO-REORDERING: Sort by last message timestamp (newest first)
      requests.sort((a, b) => {
        const timeA = a.lastMessageTimestamp;
        const timeB = b.lastMessageTimestamp;

        // Convert to timestamps for comparison
        const timestampA = new Date(timeA).getTime();
        const timestampB = new Date(timeB).getTime();

        // Sort descending (newest first)
        return timestampB - timestampA;
      });
    }
  }

  // Apply pagination after sorting
  let paginatedRequests = requests.slice(skip, skip + limit);

  const pagination = {
    currentPage: page,
    totalPages: Math.ceil(totalRequests / limit),
    totalItems: totalRequests,
    itemsPerPage: limit,
  };

  const responseData = {
    message: `Requests (${type})`,
    data: paginatedRequests,
    pagination
  };

  try {
    await redisClient.setEx(cacheKey, 60, JSON.stringify(responseData));
  } catch { }

  // ✅ EMIT SOCKET EVENT FOR CHAT LIST UPDATE
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit("chatList:update", {
      type: type,
      action: "listFetched",
      data: paginatedRequests,
      pagination: pagination
    });
    console.log(`📡 Chat list socket event emitted to user ${userId} for type: ${type}`);
  } catch (err) {
    console.error("Socket emit error (chat list):", err.message);
  }

  return successResponse(res, `Requests (${type})`, paginatedRequests, pagination, 200, 1);
});

export default { sendChatRequest };
