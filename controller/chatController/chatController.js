import ChatRequest from "../../models/ChatRequest.js";
import ChatConversation from "../../models/ChatConversation.js";
import redisClient from "../../config/redis.js";
import User from "../../models/User.js";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/errorHandler.js";
import { formatMessageTimestamp } from "../../utils/time.js";
import { successResponse, errorResponse } from "../../utils/response.js";
import { getIO } from "../../config/socket.js";
import { sendFirebaseNotification } from "../../utils/firebaseHelper.js";
import Notification from "../../models/Notification.js";
import { checkUserDeleted } from "../../utils/chatHelper.js";

// Minimal in-memory websocket-like message save via HTTP for individual chats
export const sendIndividualTextMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params; // ChatRequest ID
  const userId = req.user?.id;
  const { message } = req.body;
  if (!message || !message.trim()) return errorResponse(res, "message is required", 404);

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    // Invalid ID format - return 200 with status 0 (API worked, but chat not found)
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  // Resolve ChatRequest → participants, must be accepted individual
  const request = await ChatRequest.findById(chatId);
  // Chat not found - return 200 with status 0 (API worked, but chat not found)
  if (!request) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }
  if (request.chatType !== 'individual') return errorResponse(res, "Not an individual chat", 404);
  if (request.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);

  const participants = [request.senderId.toString(), request.receiverId.toString()];
  if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

  // ✅ Check if partner user is deleted
  const partnerId = String(request.senderId) === String(userId)
    ? request.receiverId
    : request.senderId;
  const partner = await User.findById(partnerId).select("isDeleted");
  const isPartnerDeleted = partner && partner.isDeleted === true;

  // Upsert to ChatConversation instead of IndividualChat
  const convo = await ChatConversation.findOneAndUpdate(
    { chatRequestId: request._id },
    {
      $setOnInsert: { chatType: 'individual' },
      $set: { participants },
      $push: { messages: { sender: userId, content: message, messageType: 'text' } }
    },
    { upsert: true, new: true }
  ).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });
  const last = convo.messages[convo.messages.length - 1];
  const ts = formatMessageTimestamp(last.createdAt || Date.now());
  const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

  // ✅ Handle deleted users in sender info
  // If partner is deleted, show "Profile Deleted" as sender info
  let senderInfo;
  if (isPartnerDeleted) {
    // Partner is deleted, show deleted account details
    senderInfo = {
      _id: String(userId),
      firstname: "Profile",
      lastname: "Deleted",
      email: "",
      profileimg: "/uploads/default.png",
      isDeleted: true
    };
  } else if (last.sender?._id) {
    if (last.sender.isDeleted === true) {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: last.sender.firstname,
        lastname: last.sender.lastname,
        email: last.sender.email,
        profileimg: last.sender.profileimg
      };
    }
  } else {
    senderInfo = {
      _id: String(userId)
    };
  }
  const messageData = {
    messageId: String(last._id),
    chatRequestId: chatId,
    content: last.content,
    mediaUrl: last.mediaUrl || null,
    messageType: last.messageType || 'text',
    createdAt: last.createdAt,
    time: displayTime,
    sender: senderInfo,
    type: 'send'
  };

  // Emit socket event to chat room for real-time notifications
  try {
    const io = getIO();

    // Emit to chat room (clients subscribed via GET will receive)
    io.to(`chat:${chatId}`).emit("newMessage", {
      ...messageData,
      chatId: String(chatId),
      type: 'receive',
      sender: senderInfo
    });
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }

  return successResponse(res, "Message sent", messageData, null, 200);
});

// Unified message sender for individual and group
export const sendChatMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params; // ChatRequest ID (individual accepted request or group root/invite)
  const userId = req.user?.id;
  const { message } = req.body;
  if (!message || !message.trim()) return errorResponse(res, "message is required", 404);

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    // Invalid ID format - return 200 with status 0 (API worked, but chat id not found)
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  // Chat not found - return 200 with status 0 (API worked, but chat id not found)
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  // Individual chat flow (must be accepted and participant)
  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);

    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    // ✅ Check if partner user is deleted
    const partnerId = String(reqDoc.senderId) === String(userId)
      ? reqDoc.receiverId
      : reqDoc.senderId;
    const partner = await User.findById(partnerId).select("isDeleted");
    const isPartnerDeleted = partner && partner.isDeleted === true;

    const participantsSet = new Set([reqDoc.senderId.toString(), reqDoc.receiverId.toString()]);
    const convo = await ChatConversation.findOneAndUpdate(
      { chatRequestId: reqDoc._id },
      {
        $setOnInsert: { chatType: 'individual' },
        $set: { participants: Array.from(participantsSet) },
        $push: { messages: { sender: userId, content: message, messageType: 'text' } }
      },
      { upsert: true, new: true }
    ).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

    const last = convo.messages[convo.messages.length - 1];
    const ts = formatMessageTimestamp(last.createdAt || Date.now());
    const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

    // ✅ Handle deleted users in sender info
    // If partner is deleted, show "Profile Deleted" as sender info
    let senderInfo;
    if (isPartnerDeleted) {
      // Partner is deleted, show deleted account details
      senderInfo = {
        _id: String(userId),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else if (last.sender?._id) {
      if (last.sender.isDeleted === true) {
        senderInfo = {
          _id: String(last.sender._id),
          firstname: "Profile",
          lastname: "Deleted",
          email: "",
          profileimg: "/uploads/default.png",
          isDeleted: true
        };
      } else {
        senderInfo = {
          _id: String(last.sender._id),
          firstname: last.sender.firstname,
          lastname: last.sender.lastname,
          email: last.sender.email,
          profileimg: last.sender.profileimg
        };
      }
    } else {
      senderInfo = {
        _id: String(userId)
      };
    }
    const baseMessageData = {
      messageId: String(last._id),
      chatRequestId: chatId,
      content: last.content,
      mediaUrl: last.mediaUrl || null,
      messageType: last.messageType || 'text',
      createdAt: last.createdAt,
      time: displayTime,
      sender: senderInfo
    };
    const senderChatListMessage = { ...baseMessageData, type: 'send' };
    const receiverChatListMessage = { ...baseMessageData, type: 'receive' };

    // ✅ EMIT SOCKET EVENT TO CHAT ROOM
    try {
      const io = getIO();

      // Emit to chat room (both participants will receive)
      io.to(`chat:${chatId}`).emit("newMessage", {
        ...baseMessageData,
        chatId: String(chatId),
        type: 'receive',
        sender: senderInfo
      });

      // ✅ Stop typing indicator when message is sent
      io.to(`chat:${chatId}`).emit("userTyping", {
        chatId: String(chatId),
        userId: String(userId),
        isTyping: false
      });

      console.log(`📨 Message sent to individual chat room: chat:${chatId}`);
    } catch (error) {
      console.error("Socket emit error (individual chat):", error.message);
    }

    // ✅ EMIT SOCKET EVENT TO UPDATE CHAT LIST FOR BOTH USERS
    try {
      const io = getIO();
      const otherUserId = String(reqDoc.senderId) === String(userId)
        ? String(reqDoc.receiverId)
        : String(reqDoc.senderId);

      // Notify both users to refresh their chat list
      io.to(`user:${userId}`).emit("chatList:update", {
        chatId: String(chatId),
        action: "newMessage",
        lastMessage: senderChatListMessage
      });

      io.to(`user:${otherUserId}`).emit("chatList:update", {
        chatId: String(chatId),
        action: "newMessage",
        lastMessage: receiverChatListMessage
      });

      console.log(`🔔 Chat list update sent to both users`);
    } catch (error) {
      console.error("Socket emit error (chat list update):", error.message);
    }

    try {
      const sender = await User.findById(userId).select("firstname lastname email");
      const receiverId =
        String(reqDoc.senderId) === String(userId)
          ? reqDoc.receiverId
          : reqDoc.senderId;
      const receiver = await User.findById(receiverId).select("firstname lastname email fcmToken");

      if (receiver) {
        const senderName = `${sender.firstname || ""} ${sender.lastname || ""}`.trim() || sender.email;

        const title = "New Message Received";
        const body = `${senderName}: ${message}`;

        // Save to Notification DB
        const notification = await Notification.create({
          userId: receiver._id,
          title,
          message: body,
          deeplink: "",
        });

        console.log(`💾 Notification saved to DB for user ${receiver._id}: ${notification}`);

        if (receiver.fcmToken) {
          const pushResult = await sendFirebaseNotification(
            receiver.fcmToken,
            title,
            body,
            { type: "chat_message", senderId: userId.toString(), deeplink: "" }
          );

          notification.firebaseStatus = pushResult.success ? "sent" : "failed";
          await notification.save();

          if (pushResult.success) {
            console.log(`✅ Push notification sent to ${receiver.email}`);
          } else {
            console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
            if (pushResult.error?.includes("invalid-registration-token")) {
              await User.findByIdAndUpdate(receiver._id, { $unset: { fcmToken: 1 } });
            }
          }
        } else {
          console.warn(`⚠️ Receiver has no FCM token`);
        }
      }
    } catch (err) {
      console.error("❌ Error sending chat push notification:", err.message);
    }

    // Clear cache for both users
    try {
      await redisClient.del([
        `chat:${String(reqDoc._id)}`,
        `requests:${String(reqDoc.senderId)}:accepted`,
        `requests:${String(reqDoc.receiverId)}:accepted`
      ]);
    } catch { }

    return successResponse(res, 'Message sent', senderChatListMessage, null, 200, 1);
  }

  // Group chat flow: find root (receiverId=null)
  let groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });
  if (!groupRoot) return successResponse(res, 'Group id not found', null, null, 200, 0);

  // Only groupAdmin, superAdmins, or members can post
  const isParticipant = String(groupRoot.groupAdmin) === String(userId)
    || (groupRoot.superAdmins || []).map(String).includes(String(userId))
    || (groupRoot.members || []).map(String).includes(String(userId));
  if (!isParticipant) return successResponse(res, 'You are not a member of this group', null, null, 200, 0);

  // Persist message in unified ChatMessage collection
  // Upsert conversation doc for group
  const participants = [groupRoot.groupAdmin, ...(groupRoot.superAdmins || []), ...(groupRoot.members || [])].map(String);
  const uniqueParticipants = Array.from(new Set(participants));
  const convo = await ChatConversation.findOneAndUpdate(
    { chatRequestId: groupRoot._id },
    {
      $setOnInsert: { chatType: 'group' },
      $set: { participants: uniqueParticipants },
      $push: { messages: { sender: userId, content: message, messageType: 'text' } }
    },
    { upsert: true, new: true }
  ).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });
  // Bump group root updatedAt so group lists sort with newest message first
  try {
    groupRoot.updatedAt = new Date();
    await groupRoot.save();
  } catch { }
  const last = convo.messages[convo.messages.length - 1];
  const ts = formatMessageTimestamp(last.createdAt || Date.now());
  const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

  // ✅ Handle deleted users in sender info
  let senderInfo;
  if (last.sender?._id) {
    if (last.sender.isDeleted === true) {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: last.sender.firstname,
        lastname: last.sender.lastname,
        email: last.sender.email,
        profileimg: last.sender.profileimg
      };
    }
  } else {
    senderInfo = {
      _id: String(userId)
    };
  }
  const baseGroupMessage = {
    messageId: String(last._id),
    chatRequestId: String(groupRoot._id),
    content: last.content,
    mediaUrl: last.mediaUrl || null,
    messageType: last.messageType || 'text',
    createdAt: last.createdAt,
    time: displayTime,
    sender: senderInfo
  };

  // Emit socket event to chat room for real-time notifications
  try {
    const io = getIO();

    // Emit to chat room (clients subscribed via GET will receive)
    io.to(`chat:${String(groupRoot._id)}`).emit("newMessage", {
      ...baseGroupMessage,
      chatId: String(groupRoot._id),
      type: 'receive',
      sender: senderInfo
    });

    // ✅ Stop typing indicator when message is sent (for groups)
    io.to(`chat:${String(groupRoot._id)}`).emit("userTyping", {
      chatId: String(groupRoot._id),
      userId: String(userId),
      isTyping: false
    });

    // ✅ EMIT SOCKET EVENT TO UPDATE CHAT LIST FOR ALL GROUP MEMBERS
    const allGroupMemberIds = [
      String(groupRoot.groupAdmin),
      ...(groupRoot.superAdmins || []).map(String),
      ...(groupRoot.members || []).map(String)
    ].filter(id => id !== String(userId));

    allGroupMemberIds.forEach(memberId => {
      io.to(`user:${memberId}`).emit("chatList:update", {
        chatId: String(groupRoot._id),
        action: "newMessage",
        lastMessage: { ...baseGroupMessage, type: 'receive' },
        type: "group"
      });
    });

    // Also emit to sender
    io.to(`user:${userId}`).emit("chatList:update", {
      chatId: String(groupRoot._id),
      action: "newMessage",
      lastMessage: { ...baseGroupMessage, type: 'send' },
      type: "group"
    });

    console.log(`🔔 Chat list update sent to all group members for group ${groupRoot._id}`);
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }

  try {
    const sender = await User.findById(userId).select("firstname lastname email");
    const senderName = `${sender.firstname || ""} ${sender.lastname || ""}`.trim() || sender.email;

    const title = "New Group Message";
    const body = `${senderName}: ${message}`;

    const receivers = await User.find({
      _id: { $in: uniqueParticipants.filter((id) => id !== String(userId)) },
    }).select("fcmToken email");

    for (const receiver of receivers) {
      const notification = await Notification.create({
        userId: receiver._id,
        title,
        message: body,
        deeplink: "",
      });

      console.log(`💾 Notification saved to DB for group member ${receiver._id}: ${notification}`);

      if (receiver.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          receiver.fcmToken,
          title,
          body,
          { type: "group_message", senderId: userId.toString(), groupId: groupRoot._id.toString() }
        );

        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();

        if (pushResult.success)
          console.log(`✅ Push sent to group member ${receiver.email}`);
        else
          console.error(`⚠️ Firebase failed for ${receiver.email}: ${pushResult.error}`);
      }
    }
  } catch (err) {
    console.error("❌ Error sending group notification:", err.message);
  }

  try { await redisClient.del([`chat:${String(groupRoot._id)}`]); } catch { }
  return successResponse(res, 'Message sent', { ...baseGroupMessage, type: 'send' }, null, 200, 1);
});

// POST /api/chat/:chatId/media (image|video|audio|pdf) – 10MB images, 50MB video, 20MB audio, 10MB pdf
export const uploadChatMedia = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    // Invalid ID format - return 200 with status 0 (API worked, but chat id not found)
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  // Chat not found - return 200 with status 0 (API worked, but chat id not found)
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  // ✅ Check if partner user is deleted (for individual chats)
  let isPartnerDeleted = false;
  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    // Check if partner user is deleted
    const partnerId = String(reqDoc.senderId) === String(userId)
      ? reqDoc.receiverId
      : reqDoc.senderId;
    const partner = await User.findById(partnerId).select("isDeleted");
    isPartnerDeleted = partner && partner.isDeleted === true;
  } else {
    const groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });
    if (!groupRoot) return successResponse(res, "Group id not found", null, null, 200, 0);
    const isParticipant = String(groupRoot.groupAdmin) === String(userId)
      || (groupRoot.superAdmins || []).map(String).includes(String(userId))
      || (groupRoot.members || []).map(String).includes(String(userId));
    if (!isParticipant) return successResponse(res, "You are not a member of this group", null, null, 200, 0);
  }

  const file = req.file;
  if (!file) return errorResponse(res, "No file uploaded", 404);

  let messageType = 'image';
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) messageType = 'video';
  else if (["mp3", "wav", "aac", "m4a", "ogg"].includes(ext)) messageType = 'audio';
  else if (["pdf"].includes(ext)) messageType = 'pdf';

  // Upsert conversation and push media message
  const chatKeyId = reqDoc.chatType === 'group' && reqDoc.receiverId !== null ? reqDoc.groupId : reqDoc._id;
  const participants = reqDoc.chatType === 'individual'
    ? [reqDoc.senderId.toString(), reqDoc.receiverId.toString()]
    : undefined; // we do not recompute group participants here

  const update = {
    $setOnInsert: { chatType: reqDoc.chatType },
    $push: { messages: { sender: userId, content: `/uploads/${file.filename}`, mediaUrl: `/uploads/${file.filename}`, messageType } }
  };
  if (participants) update.$set = { participants };

  const convo = await ChatConversation.findOneAndUpdate(
    { chatRequestId: chatKeyId },
    update,
    { upsert: true, new: true }
  ).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

  const last = convo.messages[convo.messages.length - 1];
  const ts = formatMessageTimestamp(last.createdAt || Date.now());
  const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

  // ✅ Handle deleted users in sender info
  // If partner is deleted (for individual chats), show "Profile Deleted" as sender info
  let senderInfo;
  if (reqDoc.chatType === 'individual' && isPartnerDeleted) {
    // Partner is deleted, show deleted account details
    senderInfo = {
      _id: String(userId),
      firstname: "Profile",
      lastname: "Deleted",
      email: "",
      profileimg: "/uploads/default.png",
      isDeleted: true
    };
  } else if (last.sender?._id) {
    if (last.sender.isDeleted === true) {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else {
      senderInfo = {
        _id: String(last.sender._id),
        firstname: last.sender.firstname,
        lastname: last.sender.lastname,
        email: last.sender.email,
        profileimg: last.sender.profileimg
      };
    }
  } else {
    senderInfo = {
      _id: String(userId)
    };
  }
  const baseMessageData = {
    messageId: String(last._id),
    chatRequestId: String(chatKeyId),
    content: last.content,
    mediaUrl: last.mediaUrl,
    messageType: last.messageType,
    createdAt: last.createdAt,
    time: displayTime,
    sender: senderInfo
  };

  // Emit socket event to chat room for real-time notifications
  try {
    const io = getIO();

    // Emit to chat room (clients subscribed via GET will receive)
    io.to(`chat:${String(chatKeyId)}`).emit("newMessage", {
      ...baseMessageData,
      chatId: String(chatKeyId),
      type: 'receive',
      sender: senderInfo
    });

    // ✅ Stop typing indicator when media message is sent
    io.to(`chat:${String(chatKeyId)}`).emit("userTyping", {
      chatId: String(chatKeyId),
      userId: String(userId),
      isTyping: false
    });

    // ✅ EMIT SOCKET EVENT TO UPDATE CHAT LIST FOR MEDIA MESSAGES
    if (reqDoc.chatType === "individual") {
      const otherUserId =
        String(reqDoc.senderId) === String(userId)
          ? reqDoc.receiverId
          : reqDoc.senderId;

      io.to(`user:${userId}`).emit("chatList:update", {
        chatId: String(chatKeyId),
        action: "newMessage",
        lastMessage: { ...baseMessageData, type: 'send' },
        type: "individual"
      });

      io.to(`user:${otherUserId}`).emit("chatList:update", {
        chatId: String(chatKeyId),
        action: "newMessage",
        lastMessage: { ...baseMessageData, type: 'receive' },
        type: "individual"
      });
    } else if (reqDoc.chatType === "group") {
      const groupRoot =
        reqDoc.receiverId === null
          ? reqDoc
          : await ChatRequest.findOne({
            _id: reqDoc.groupId,
            chatType: "group",
            receiverId: null,
          }).select("members superAdmins groupAdmin");

      if (groupRoot) {
        const allGroupMemberIds = [
          String(groupRoot.groupAdmin),
          ...(groupRoot.superAdmins || []).map(String),
          ...(groupRoot.members || []).map(String)
        ].filter(id => id !== String(userId));

        allGroupMemberIds.forEach(memberId => {
          io.to(`user:${memberId}`).emit("chatList:update", {
            chatId: String(chatKeyId),
            action: "newMessage",
            lastMessage: { ...baseMessageData, type: 'receive' },
            type: "group"
          });
        });

        io.to(`user:${userId}`).emit("chatList:update", {
          chatId: String(chatKeyId),
          action: "newMessage",
          lastMessage: { ...baseMessageData, type: 'send' },
          type: "group"
        });
      }
    }
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }

  // ✅ PUSH & DB NOTIFICATION (Individual or Group)
  try {
    const sender = await User.findById(userId).select("firstname lastname email");
    const senderName = `${sender.firstname || ""} ${sender.lastname || ""}`.trim() || sender.email;
    const io = getIO();

    let title = "";
    let message = "";
    let receivers = [];

    // ✅ INDIVIDUAL CHAT
    if (reqDoc.chatType === "individual") {
      const otherUserId =
        String(reqDoc.senderId) === String(userId)
          ? reqDoc.receiverId
          : reqDoc.senderId;
      const receiver = await User.findById(otherUserId).select("fcmToken email");

      if (receiver) {
        title = "New Media Message";
        const fileName = file.originalname || "a file";
        message = `${senderName} sent you ${fileName}`;

        // Save DB Notification
        const notification = await Notification.create({
          userId: receiver._id,
          title,
          message,
          deeplink: "",
        });

        console.log(`💾 Notification saved to DB for user ${receiver._id}: ${notification}`);

        // Send Firebase Notification
        if (receiver.fcmToken) {
          const pushResult = await sendFirebaseNotification(
            receiver.fcmToken,
            title,
            message,
            { type: "chat_media", chatId: chatKeyId.toString(), senderId: userId }
          );

          notification.firebaseStatus = pushResult.success ? "sent" : "failed";
          await notification.save();

          if (pushResult.success) {
            console.log(`✅ Media notification sent to ${receiver.email}`);
          } else {
            console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
            if (pushResult.error.includes("invalid-registration-token")) {
              await User.findByIdAndUpdate(receiver._id, { $unset: { fcmToken: 1 } });
            }
          }
        } else {
          console.warn("⚠️ Receiver has no FCM token, skipping push notification");
        }

        io.to(`user:${otherUserId}`).emit("chat:media", {
          chatId: chatKeyId,
          message,
          sender: senderName,
        });
      }
    }

    // ✅ GROUP CHAT
    else if (reqDoc.chatType === "group") {
      const groupRoot =
        reqDoc.receiverId === null
          ? reqDoc
          : await ChatRequest.findOne({
            _id: reqDoc.groupId,
            chatType: "group",
            receiverId: null,
          }).select("members superAdmins groupAdmin name");

      if (groupRoot) {
        title = "New Group Media";
        const fileName = file.originalname || "a file";
        message = `${senderName} shared ${fileName} in “${groupRoot.name || "Group"}”`;

        // Collect all group users except sender
        receivers = [
          String(groupRoot.groupAdmin),
          ...(groupRoot.superAdmins || []).map(String),
          ...(groupRoot.members || []).map(String),
        ].filter((id) => id !== String(userId));

        for (const receiverId of receivers) {
          const receiver = await User.findById(receiverId).select("fcmToken email");
          if (!receiver) continue;

          const notification = await Notification.create({
            userId: receiver._id,
            title,
            message,
            deeplink: "",
          });

          console.log(`💾 Notification saved to DB for group member ${receiver._id}: ${notification}`);

          if (receiver.fcmToken) {
            const pushResult = await sendFirebaseNotification(
              receiver.fcmToken,
              title,
              message,
              {
                type: "group_media",
                groupId: groupRoot._id.toString(),
                senderId: userId,
              }
            );

            notification.firebaseStatus = pushResult.success ? "sent" : "failed";
            await notification.save();

            if (pushResult.success) {
              console.log(`✅ Group media notification sent to ${receiver.email}`);
            } else {
              console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
              if (pushResult.error.includes("invalid-registration-token")) {
                await User.findByIdAndUpdate(receiver._id, { $unset: { fcmToken: 1 } });
              }
            }
          } else {
            console.warn(`⚠️ Group user ${receiver.email} has no FCM token`);
          }

          io.to(`user:${receiverId}`).emit("group:media", {
            groupId: groupRoot._id,
            message,
            sender: senderName,
          });
        }
      }
    }
  } catch (err) {
    console.error("❌ Error sending media notification:", err.message);
  }
  try { await redisClient.del([`chat:${String(chatKeyId)}`]); } catch { }
  return successResponse(res, 'Message sent', { ...baseMessageData, type: 'send' }, null, 200, 1);
});

export const getIndividualMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params; // ChatRequest ID
  const userId = req.user?.id;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    // Invalid ID format - return 200 with status 0 (API worked, but chat id not found)
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  // Chat not found - return 200 with status 0 (API worked, but chat id not found)
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }
  if (reqDoc.chatType !== 'individual') return errorResponse(res, "Not an individual chat", 404);
  if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
  const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
  if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

  const cacheKey = `chat:${String(reqDoc._id)}:user:${String(userId)}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    return successResponse(res, parsed.message, parsed.data);
  }

  const convo = await ChatConversation.findOne({ chatRequestId: reqDoc._id })
    .populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

  // ✅ CREATE A MAP OF DELETED MESSAGE IDs FOR CURRENT USER FROM deletedForMe
  const deletedForMeMap = new Map();
  if (convo?.deletedForMe && Array.isArray(convo.deletedForMe)) {
    convo.deletedForMe.forEach(deletion => {
      if (deletion.userId && deletion.userId.toString() === userId.toString()) {
        deletedForMeMap.set(deletion.messageId.toString(), deletion);
      }
    });
  }

  const messages = (convo?.messages || []).map(m => {
    const ts = formatMessageTimestamp(m.createdAt || Date.now());
    const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

    // ✅ READ DELETION FLAGS FROM DATABASE
    const isDeleteEvery = m.isDeleteEvery === true;
    // ✅ USER-SPECIFIC DELETION: Only check deletedForMe array (not global isDeleteMe flag)
    const isDeleteMe = deletedForMeMap.has(m._id.toString());

    // If message is deleted for me (current user), don't include it in response
    if (isDeleteMe) {
      return null;
    }

    return {
      _id: String(m._id),
      content: isDeleteEvery ? "This message has been deleted" : m.content,
      mediaUrl: isDeleteEvery ? null : m.mediaUrl,
      messageType: isDeleteEvery ? "text" : (m.messageType || "text"),
      isDeleteEvery: isDeleteEvery,
      isDeleteMe: isDeleteMe,
      deletedAt: m.deletedAt || null,
      createdAt: m.createdAt,
      time: displayTime,
      sender: m.sender?._id ? (m.sender.isDeleted === true ? {
        _id: String(m.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      } : {
        _id: String(m.sender._id),
        firstname: m.sender.firstname,
        lastname: m.sender.lastname,
        email: m.sender.email,
        profileimg: m.sender.profileimg
      }) : m.sender,
      type: String(m.sender?._id || m.sender) === String(userId) ? 'send' : 'receive'
    };
  }).filter(m => m !== null); // Filter out null messages (deleted for me)

  const data = { chatRequestId: chatId, messages };
  try { await redisClient.setEx(cacheKey, 60, JSON.stringify({ message: "Messages fetched", data })); } catch { }
  return successResponse(res, "Messages fetched", data, null, 200, 1);
});

export const getChatMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search ? req.query.search.trim() : "";
  const skip = (page - 1) * limit;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const cacheKey = `chat:${String(chatId)}:user:${String(userId)}:page:${page}:limit:${limit}:search:${search}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    return successResponse(res, parsed.message, parsed.data, parsed.pagination, 200, 1);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  // Individual chat
  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    // Mark messages as read for this user
    try {
      await ChatConversation.findOneAndUpdate(
        { chatRequestId: reqDoc._id },
        { $set: { [`lastReadAtByUser.${String(userId)}`]: new Date() } },
        { upsert: true }
      );
    } catch { }

    const convo = await ChatConversation.findOne({ chatRequestId: reqDoc._id })
      .populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

    // ✅ CREATE A MAP OF DELETED MESSAGE IDs FOR CURRENT USER FROM deletedForMe
    const deletedForMeMap = new Map();
    if (convo?.deletedForMe && Array.isArray(convo.deletedForMe)) {
      convo.deletedForMe.forEach(deletion => {
        if (deletion.userId && deletion.userId.toString() === userId.toString()) {
          deletedForMeMap.set(deletion.messageId.toString(), deletion);
        }
      });
    }

    let messages = (convo?.messages || []).map(m => {
      const ts = formatMessageTimestamp(m.createdAt || Date.now());
      const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

      // ✅ READ DELETION FLAGS FROM DATABASE
      const isDeleteEvery = m.isDeleteEvery === true;
      // ✅ USER-SPECIFIC DELETION: Only check deletedForMe array (not global isDeleteMe flag)
      // isDeleteMe on message is a global flag, deletedForMe is user-specific
      const isDeleteMe = deletedForMeMap.has(m._id.toString());

      // If message is deleted for me (current user), don't include it in response
      if (isDeleteMe) {
        return null;
      }

      return {
        _id: String(m._id),
        content: isDeleteEvery ? "This message has been deleted" : m.content,
        mediaUrl: isDeleteEvery ? null : m.mediaUrl,
        messageType: isDeleteEvery ? "text" : m.messageType,
        // NEW: Read flags from database
        isDeleteMe: isDeleteMe,
        isDeleteEvery: isDeleteEvery,
        deletedAt: m.deletedAt || null,
        deletedBy: m.deletedBy ? String(m.deletedBy) : null,
        deletedFor: m.deletedFor || null,
        canEdit: !isDeleteEvery &&
          !isDeleteMe &&
          String(m.sender?._id || m.sender) === String(userId) &&
          m.messageType === 'text' &&
          !m.mediaUrl,
        createdAt: m.createdAt,
        isEdited: m.isEdited || false,
        editedAt: m.editedAt || null,
        time: displayTime,
        sender: m.sender?._id ? (m.sender.isDeleted === true ? {
          _id: String(m.sender._id),
          firstname: "Profile",
          lastname: "Deleted",
          email: "",
          profileimg: "/uploads/default.png",
          isDeleted: true
        } : {
          _id: String(m.sender._id),
          firstname: m.sender.firstname,
          lastname: m.sender.lastname,
          email: m.sender.email,
          profileimg: m.sender.profileimg
        }) : m.sender,
        type: String(m.sender?._id || m.sender) === String(userId) ? 'send' : 'receive'
      };
    });

    // Filter out null messages (deleted for me)
    messages = messages.filter(m => m !== null);

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      messages = messages.filter(m => {
        return !m.isDeleteEvery && m.content && m.content.toLowerCase().includes(searchLower);
      });
    }

    // Sort and paginate
    messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const totalMessages = messages.length;
    const paginatedMessages = messages.slice(skip, skip + limit);
    paginatedMessages.reverse();

    const pagination = {
      currentPage: page,
      totalPages: Math.ceil(totalMessages / limit),
      totalItems: totalMessages,
      itemsPerPage: limit,
    };

    const data = { chatRequestId: chatId, messages: paginatedMessages };
    const responseData = { message: "Messages fetched", data, pagination };
    try { await redisClient.setEx(cacheKey, 60, JSON.stringify(responseData)); } catch { }
    return successResponse(res, "Messages fetched", data, pagination, 200, 1);
  }

  // Group chat (similar logic as individual)
  const groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });
  if (!groupRoot) return successResponse(res, "Group id not found", null, null, 200, 0);

  const isParticipant = String(groupRoot.groupAdmin) === String(userId)
    || (groupRoot.superAdmins || []).map(String).includes(String(userId))
    || (groupRoot.members || []).map(String).includes(String(userId));
  if (!isParticipant) return successResponse(res, "You are not a member of this group", null, null, 200, 0);

  // Mark messages as read for this user
  try {
    await ChatConversation.findOneAndUpdate(
      { chatRequestId: groupRoot._id },
      { $set: { [`lastReadAtByUser.${String(userId)}`]: new Date() } },
      { upsert: true }
    );
  } catch { }

  const convo = await ChatConversation.findOne({ chatRequestId: groupRoot._id })
    .populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

  let joinedAtDate = null;
  if (convo?.joinedAtByUser) {
    const joinedEntry = typeof convo.joinedAtByUser.get === "function"
      ? convo.joinedAtByUser.get(String(userId))
      : convo.joinedAtByUser[String(userId)];
    if (joinedEntry) {
      joinedAtDate = new Date(joinedEntry);
    }
  }

  // ✅ CREATE A MAP OF DELETED MESSAGE IDs FOR CURRENT USER FROM deletedForMe
  const deletedForMeMap = new Map();
  if (convo?.deletedForMe && Array.isArray(convo.deletedForMe)) {
    convo.deletedForMe.forEach(deletion => {
      if (deletion.userId && deletion.userId.toString() === userId.toString()) {
        deletedForMeMap.set(deletion.messageId.toString(), deletion);
      }
    });
  }

  let messages = (convo?.messages || []).map(m => {
    const ts = formatMessageTimestamp(m.createdAt || Date.now());
    const displayTime = ts.dateLabel ? `${ts.timeLabel}, ${ts.dateLabel}` : ts.timeLabel;

    // ✅ READ DELETION FLAGS FROM DATABASE
    const isDeleteEvery = m.isDeleteEvery === true;
    // ✅ USER-SPECIFIC DELETION: Only check deletedForMe array (not global isDeleteMe flag)
    // isDeleteMe on message is a global flag, deletedForMe is user-specific
    const isDeleteMe = deletedForMeMap.has(m._id.toString());

    // If message is deleted for me (current user), don't include it in response
    if (isDeleteMe) {
      return null;
    }

    // Hide history for users who joined later
    if (joinedAtDate && new Date(m.createdAt) < joinedAtDate) {
      return null;
    }

    return {
      _id: String(m._id),
      content: isDeleteEvery ? "This message has been deleted" : m.content,
      mediaUrl: isDeleteEvery ? null : m.mediaUrl,
      messageType: isDeleteEvery ? "text" : m.messageType,
      // NEW: Read flags from database
      isDeleteMe: isDeleteMe,
      isDeleteEvery: isDeleteEvery,
      deletedAt: m.deletedAt || null,
      deletedBy: m.deletedBy ? String(m.deletedBy) : null,
      deletedFor: m.deletedFor || null,
      canEdit: !isDeleteEvery &&
        !isDeleteMe &&
        String(m.sender?._id || m.sender) === String(userId) &&
        m.messageType === 'text' &&
        !m.mediaUrl,
      createdAt: m.createdAt,
      isEdited: m.isEdited || false,
      editedAt: m.editedAt || null,
      time: displayTime,
      sender: m.sender?._id ? (m.sender.isDeleted === true ? {
        _id: String(m.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      } : {
        _id: String(m.sender._id),
        firstname: m.sender.firstname,
        lastname: m.sender.lastname,
        email: m.sender.email,
        profileimg: m.sender.profileimg
      }) : m.sender,
      type: String(m.sender?._id || m.sender) === String(userId) ? 'send' : 'receive'
    };
  });

  // Filter out null messages (deleted for me)
  messages = messages.filter(m => m !== null);

  // Apply search filter if provided
  if (search) {
    const searchLower = search.toLowerCase();
    messages = messages.filter(m => {
      return !m.isDeleteEvery && m.content && m.content.toLowerCase().includes(searchLower);
    });
  }

  // Sort and paginate
  messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const totalMessages = messages.length;
  const paginatedMessages = messages.slice(skip, skip + limit);
  paginatedMessages.reverse();

  const pagination = {
    currentPage: page,
    totalPages: Math.ceil(totalMessages / limit),
    totalItems: totalMessages,
    itemsPerPage: limit,
  };

  const data = {
    chatRequestId: String(groupRoot._id),
    groupImage: groupRoot.groupImage,
    messages: paginatedMessages
  };
  const responseData = { message: "Messages fetched", data, pagination };
  try { await redisClient.setEx(cacheKey, 60, JSON.stringify(responseData)); } catch { }
  return successResponse(res, "Messages fetched", data, pagination, 200, 1);
});