import ChatRequest from "../../models/ChatRequest.js";
import ChatConversation from "../../models/ChatConversation.js";
import redisClient from "../../config/redis.js";
import User from "../../models/User.js";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/errorHandler.js";
import { successResponse, errorResponse } from "../../utils/response.js";
import { getIO } from "../../config/socket.js";
import { sendFirebaseNotification } from "../../utils/firebaseHelper.js";
import Notification from "../../models/Notification.js";
import {
  createMessageResponse,
  createDeletedForMeMap,
  filterVisibleMessages
} from "../../utils/messageUtils.js";

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

export const sendIndividualTextMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;
  const { message } = req.body;
  if (!message || !message.trim()) return errorResponse(res, "message is required", 404);

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const request = await ChatRequest.findById(chatId);
  if (!request) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }
  if (request.chatType !== 'individual') return errorResponse(res, "Not an individual chat", 404);
  if (request.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);

  const participants = [request.senderId.toString(), request.receiverId.toString()];
  if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

  const partnerId = String(request.senderId) === String(userId) ? request.receiverId : request.senderId;
  const partner = await User.findById(partnerId).select("isDeleted");
  const isPartnerDeleted = partner && partner.isDeleted === true;

  const participantsSet = new Set([request.senderId.toString(), request.receiverId.toString()]);
  const convo = await ChatConversation.findOneAndUpdate(
    { chatRequestId: request._id },
    {
      $setOnInsert: { chatType: 'individual' },
      $set: { participants: Array.from(participantsSet) },
      $push: { messages: { sender: userId, content: message, messageType: 'text' } }
    },
    { upsert: true, new: true }
  ).populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

  const last = convo.messages[convo.messages.length - 1];

  let senderInfo;
  if (isPartnerDeleted) {
    senderInfo = {
      _id: String(userId),
      firstname: "Profile",
      lastname: "Deleted",
      email: "",
      profileimg: "/uploads/default.png",
      isDeleted: true
    };
  } else {
    senderInfo = last.sender?._id ? {
      _id: String(last.sender._id),
      firstname: last.sender.firstname,
      lastname: last.sender.lastname,
      email: last.sender.email,
      profileimg: last.sender.profileimg
    } : { _id: String(userId) };
  }

  const messageData = createMessageResponse(
    { ...last.toObject(), sender: senderInfo },
    userId,
    chatId
  );
  messageData.type = 'send';

  try {
    const io = getIO();
    const socketMessage = { ...messageData, type: 'receive' };
    io.to(`chat:${chatId}`).emit("newMessage", socketMessage);
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }

  return successResponse(res, "Message sent", messageData, null, 200);
});

export const sendChatMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;
  const { message } = req.body;
  if (!message || !message.trim()) return errorResponse(res, "message is required", 404);

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);

    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    const partnerId = String(reqDoc.senderId) === String(userId) ? reqDoc.receiverId : reqDoc.senderId;
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

    let senderInfo;
    if (isPartnerDeleted) {
      senderInfo = {
        _id: String(userId),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else {
      senderInfo = last.sender?._id ? {
        _id: String(last.sender._id),
        firstname: last.sender.firstname,
        lastname: last.sender.lastname,
        email: last.sender.email,
        profileimg: last.sender.profileimg
      } : { _id: String(userId) };
    }

    const baseMessageData = createMessageResponse(
      { ...last.toObject(), sender: senderInfo },
      userId,
      chatId
    );

    const senderChatListMessage = { ...baseMessageData, type: 'send' };
    const receiverChatListMessage = { ...baseMessageData, type: 'receive' };

    try {
      const io = getIO();
      io.to(`chat:${String(chatId)}`).emit("newMessage", receiverChatListMessage);

      const otherUserId = String(reqDoc.senderId) === String(userId) ? String(reqDoc.receiverId) : String(reqDoc.senderId);

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

    } catch (error) {
      console.error("Socket emit error:", error.message);
    }

    try {
      const sender = await User.findById(userId).select("firstname lastname email");
      const receiverId = String(reqDoc.senderId) === String(userId) ? reqDoc.receiverId : reqDoc.senderId;
      const receiver = await User.findById(receiverId).select("firstname lastname email fcmToken");

      if (receiver) {
        const senderName = `${sender.firstname || ""} ${sender.lastname || ""}`.trim() || sender.email;
        const title = "New Message Received";
        const body = `${senderName}: ${message}`;

        const notification = await Notification.create({
          userId: receiver._id,
          title,
          message: body,
          deeplink: "",
        });

        if (receiver.fcmToken) {
          const pushResult = await sendFirebaseNotification(
            receiver.fcmToken,
            title,
            body,
            { type: "chat_message", senderId: userId.toString(), deeplink: "" }
          );

          notification.firebaseStatus = pushResult.success ? "sent" : "failed";
          await notification.save();

          if (pushResult.error?.includes("invalid-registration-token")) {
            await User.findByIdAndUpdate(receiver._id, { $unset: { fcmToken: 1 } });
          }
        }
      }
    } catch (err) {
      console.error("Error sending chat push notification:", err.message);
    }

    try {
      await redisClient.del(
        `chat:${String(reqDoc._id)}`,
        `requests:${String(reqDoc.senderId)}:accepted`,
        `requests:${String(reqDoc.receiverId)}:accepted`
      );
    } catch { }

    return successResponse(res, 'Message sent', senderChatListMessage, null, 200, 1);
  }

  let groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });
  if (!groupRoot) return successResponse(res, 'Group id not found', null, null, 200, 0);

  const isParticipant = String(groupRoot.groupAdmin) === String(userId)
    || (groupRoot.superAdmins || []).map(String).includes(String(userId))
    || (groupRoot.members || []).map(String).includes(String(userId));
  if (!isParticipant) return successResponse(res, 'You are not a member of this group', null, null, 200, 0);

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

  try {
    groupRoot.updatedAt = new Date();
    await groupRoot.save();
  } catch { }

  const last = convo.messages[convo.messages.length - 1];

  const baseGroupMessage = createMessageResponse(last, userId, groupRoot._id);
  const responseMessage = { ...baseGroupMessage, type: 'send' };

  try {
    const io = getIO();
    const socketMessage = { ...baseGroupMessage, type: 'receive' };
    io.to(`chat:${String(groupRoot._id)}`).emit("newMessage", socketMessage);

    io.to(`chat:${String(groupRoot._id)}`).emit("userTyping", {
      chatId: String(groupRoot._id),
      userId: String(userId),
      isTyping: false
    });

    const allGroupMemberIds = [
      String(groupRoot.groupAdmin),
      ...(groupRoot.superAdmins || []).map(String),
      ...(groupRoot.members || []).map(String)
    ];

    const uniqueGroupMemberIds = Array.from(new Set(allGroupMemberIds));

    uniqueGroupMemberIds.forEach(memberId => {
      const messageType = String(memberId) === String(userId) ? 'send' : 'receive';
      io.to(`user:${memberId}`).emit("chatList:update", {
        chatId: String(groupRoot._id),
        action: "newMessage",
        lastMessage: { ...baseGroupMessage, type: messageType }
      });
    });

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

      if (receiver.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          receiver.fcmToken,
          title,
          body,
          { type: "group_message", senderId: userId.toString(), groupId: groupRoot._id.toString() }
        );

        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }
    }
  } catch (err) {
    console.error("Error sending group notification:", err.message);
  }

  try {
    await redisClient.del(`chat:${String(groupRoot._id)}`);
  } catch { }

  try {
    const cacheClearTargets = [
      String(groupRoot.groupAdmin),
      ...(groupRoot.superAdmins || []).map(String),
      ...(groupRoot.members || []).map(String)
    ];
    const uniqueTargets = Array.from(new Set(cacheClearTargets));
    await Promise.all(uniqueTargets.map(async (uid) => {
      await deleteRedisKeysByPattern(`requests:${uid}:group*`);
      await deleteRedisKeysByPattern(`requests:${uid}:accepted*`);
    }));
  } catch (err) {
    console.warn("Redis group cache clear failed:", err.message);
  }

  return successResponse(res, 'Message sent', responseMessage, null, 200, 1);
});

export const uploadChatMedia = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  let isPartnerDeleted = false;
  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    const partnerId = String(reqDoc.senderId) === String(userId) ? reqDoc.receiverId : reqDoc.senderId;
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

  const chatKeyId = reqDoc.chatType === 'group' && reqDoc.receiverId !== null ? reqDoc.groupId : reqDoc._id;
  const participants = reqDoc.chatType === 'individual'
    ? [reqDoc.senderId.toString(), reqDoc.receiverId.toString()]
    : undefined;

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

  let senderInfo;
  if (reqDoc.chatType === 'individual' && isPartnerDeleted) {
    senderInfo = {
      _id: String(userId),
      firstname: "Profile",
      lastname: "Deleted",
      email: "",
      profileimg: "/uploads/default.png",
      isDeleted: true
    };
  } else {
    senderInfo = last.sender?._id ? {
      _id: String(last.sender._id),
      firstname: last.sender.firstname,
      lastname: last.sender.lastname,
      email: last.sender.email,
      profileimg: last.sender.profileimg
    } : { _id: String(userId) };
  }

  const baseMessageData = createMessageResponse(
    { ...last.toObject(), sender: senderInfo },
    userId,
    chatKeyId
  );
  const responseMessage = { ...baseMessageData, type: 'send' };

  try {
    const io = getIO();
    const socketMessage = { ...baseMessageData, type: 'receive' };
    io.to(`chat:${String(chatKeyId)}`).emit("newMessage", socketMessage);

    io.to(`chat:${String(chatKeyId)}`).emit("userTyping", {
      chatId: String(chatKeyId),
      userId: String(userId),
      isTyping: false
    });

    if (reqDoc.chatType === "individual") {
      const otherUserId = String(reqDoc.senderId) === String(userId) ? reqDoc.receiverId : reqDoc.senderId;

      io.to(`user:${userId}`).emit("chatList:update", {
        chatId: String(chatKeyId),
        action: "newMessage",
        lastMessage: responseMessage
      });

      io.to(`user:${otherUserId}`).emit("chatList:update", {
        chatId: String(chatKeyId),
        action: "newMessage",
        lastMessage: socketMessage
      });
    } else if (reqDoc.chatType === "group") {
      const groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({
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
            lastMessage: socketMessage
          });
        });

        io.to(`user:${userId}`).emit("chatList:update", {
          chatId: String(chatKeyId),
          action: "newMessage",
          lastMessage: responseMessage
        });
      }
    }
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }

  try {
    await redisClient.del(`chat:${String(chatKeyId)}`);
  } catch { }

  return successResponse(res, 'Message sent', responseMessage, null, 200, 1);
});

export const getIndividualMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const reqDoc = await ChatRequest.findById(chatId);
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

  const deletedForMeMap = createDeletedForMeMap(convo, userId);

  const messages = (convo?.messages || [])
    .map(m => {
      const isDeleteMe = deletedForMeMap.has(m._id.toString());
      if (isDeleteMe) return null;

      return createMessageResponse(m, userId, chatId);
    })
    .filter(m => m !== null);

  const data = { chatRequestId: chatId, messages };
  try {
    await redisClient.setEx(cacheKey, 60, JSON.stringify({ message: "Messages fetched", data }));
  } catch { }

  return successResponse(res, "Messages fetched", data, null, 200, 1);
});

export const getChatMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search ? req.query.search.trim() : "";
  const skip = (page - 1) * limit;

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  const cacheKey = `chat:${String(chatId)}:user:${String(userId)}:page:${page}:limit:${limit}:search:${search}:${Date.now()}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    return successResponse(res, parsed.message, parsed.data, parsed.pagination, 200, 1);
  }

  const reqDoc = await ChatRequest.findById(chatId);
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
    const participants = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participants.includes(String(userId))) return successResponse(res, "Not a participant of this chat", null, null, 200, 0);

    try {
      await ChatConversation.findOneAndUpdate(
        { chatRequestId: reqDoc._id },
        {
          $set: {
            [`lastReadAtByUser.${String(userId)}`]: new Date()
          }
        },
        { upsert: true }
      );
    } catch (error) {
      console.warn("Failed to update last read timestamp:", error.message);
    }

    const convo = await ChatConversation.findOne({ chatRequestId: reqDoc._id })
      .populate({ path: 'messages.sender', select: 'firstname lastname email profileimg isDeleted' });

    const deletedForMeMap = createDeletedForMeMap(convo, userId);

    let messages = (convo?.messages || [])
      .map(m => {
        const isDeleteMe = deletedForMeMap.has(m._id.toString());
        if (isDeleteMe) return null;
        return createMessageResponse(m, userId, chatId);
      })
      .filter(m => m !== null);

    if (search) {
      const searchLower = search.toLowerCase();
      messages = messages.filter(m => {
        return !m.isDeleteEvery && m.content && m.content.toLowerCase().includes(searchLower);
      });
    }

    messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalMessages = messages.length;
    const paginatedMessages = messages.slice(skip, skip + limit);

    const pagination = {
      currentPage: page,
      totalPages: Math.ceil(totalMessages / limit),
      totalItems: totalMessages,
      itemsPerPage: limit,
    };

    const data = { chatRequestId: chatId, messages: paginatedMessages };
    const responseData = { message: "Messages fetched", data, pagination };

    try {
      await redisClient.setEx(cacheKey, 10, JSON.stringify(responseData));
    } catch { }

    return successResponse(res, "Messages fetched", data, pagination, 200, 1);
  }

  const groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });
  if (!groupRoot) return successResponse(res, "Group id not found", null, null, 200, 0);

  const isParticipant = String(groupRoot.groupAdmin) === String(userId)
    || (groupRoot.superAdmins || []).map(String).includes(String(userId))
    || (groupRoot.members || []).map(String).includes(String(userId));
  if (!isParticipant) return successResponse(res, "You are not a member of this group", null, null, 200, 0);

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

  const deletedForMeMap = createDeletedForMeMap(convo, userId);

  let messages = (convo?.messages || [])
    .map(m => {
      const isDeleteMe = deletedForMeMap.has(m._id.toString());
      if (isDeleteMe) return null;

      if (joinedAtDate && new Date(m.createdAt) < joinedAtDate) {
        return null;
      }

      return createMessageResponse(m, userId, groupRoot._id);
    })
    .filter(m => m !== null);

  if (search) {
    const searchLower = search.toLowerCase();
    messages = messages.filter(m => {
      return !m.isDeleteEvery && m.content && m.content.toLowerCase().includes(searchLower);
    });
  }

  messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalMessages = messages.length;
  const paginatedMessages = messages.slice(skip, skip + limit);

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

  try {
    await redisClient.setEx(cacheKey, 10, JSON.stringify(responseData));
  } catch { }

  return successResponse(res, "Messages fetched", data, pagination, 200, 1);
});