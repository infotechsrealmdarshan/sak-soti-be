import ChatRequest from "../../models/ChatRequest.js";
import ChatConversation from "../../models/ChatConversation.js";
import redisClient from "../../config/redis.js";
// GroupChat removed; use ChatRequest as unified model for groups
import User from "../../models/User.js";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/errorHandler.js";
import { formatMessageTimestamp } from "../../utils/time.js";
import { successResponse, errorResponse } from "../../utils/response.js";
import { getIO } from "../../config/socket.js";
import { sendFirebaseNotification } from "../../utils/firebaseHelper.js";
import Notification from "../../models/Notification.js";

/**
 * Edit a message - user can only edit their own messages
 */
export const editMessage = asyncHandler(async (req, res) => {
  const { chatId, messageId } = req.params;
  const { content: newMessage } = req.body;
  const userId = req.user.id;

  // Validate required fields
  if (!newMessage || newMessage.trim() === '') {
    return successResponse(
      res,
      "Message content is required",
      null,
      null,
      400,
      0
    );
  }

  // Validate message ID format
  if (!messageId || messageId.length !== 24) {
    return successResponse(
      res,
      "Invalid message ID format",
      null,
      null,
      400,
      0
    );
  }

  // Validate chat ID format
  if (!chatId || chatId.length !== 24) {
    return successResponse(
      res,
      "Invalid chat ID format",
      null,
      null,
      400,
      0
    );
  }

  try {
    // All messages (individual and group) are stored in ChatConversation
    const conversation = await ChatConversation.findOne({ chatRequestId: chatId });
    if (!conversation) {
      return successResponse(res, "Chat not found", null, null, 200, 0);
    }

    // Backfill required chatType for legacy documents to avoid validation errors
    if (!conversation.chatType) {
      try {
        const reqDocForType = await ChatRequest.findById(chatId).select("chatType");
        conversation.chatType = reqDocForType?.chatType || "individual";
      } catch { /* noop */ }
    }

    const message = conversation.messages.id(messageId);
    if (!message) {
      return errorResponse(res, "Message not found", 404);
    }

    // Only sender can edit
    if (String(message.sender) !== String(userId)) {
      return errorResponse(res, "You can only edit your own messages", 403);
    }

    // Only text messages can be edited (no media)
    if ((message.messageType && message.messageType !== 'text') || message.mediaUrl) {
      return errorResponse(res, "Only text messages can be edited", 400);
    }

    // Only within 12 hours
    const createdAt = new Date(message.createdAt).getTime();
    const now = Date.now();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    if (now - createdAt > twelveHoursMs) {
      return errorResponse(res, "Message can only be edited within 12 hours of sending", 400);
    }

    // Perform edit
    message.content = newMessage.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await conversation.save();

    const updatedMessage = message;

    // Prepare response
    const messageResponse = {
      _id: updatedMessage._id,
      sender: updatedMessage.sender,
      content: updatedMessage.content,
      messageType: updatedMessage.messageType,
      mediaUrl: updatedMessage.mediaUrl,
      isEdited: updatedMessage.isEdited,
      editedAt: updatedMessage.editedAt,
      createdAt: updatedMessage.createdAt
    };

    // Emit socket event for real-time update
    try {
      const io = getIO();
      io.to(`chat:${String(chatId)}`).emit('messageEdited', {
        chatId: String(chatId),
        messageId: String(updatedMessage._id),
        content: updatedMessage.content,
        isEdited: true,
        editedAt: updatedMessage.editedAt
      });
    } catch (err) {
      console.error("Socket emit error (message edited):", err.message);
    }

    // Notifications to other participants (individual or group)
    try {
      const reqDoc = await ChatRequest.findById(chatId);
      if (reqDoc) {
        let notifyUserIds = [];
        if (reqDoc.chatType === 'individual') {
          const otherUserId = String(reqDoc.senderId) === String(userId) ? String(reqDoc.receiverId) : String(reqDoc.senderId);
          notifyUserIds = [otherUserId];
        } else {
          // group
          const groupRoot = reqDoc.receiverId === null ? reqDoc : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null }).select("members superAdmins groupAdmin");
          if (groupRoot) {
            notifyUserIds = [
              String(groupRoot.groupAdmin),
              ...(groupRoot.superAdmins || []).map(String),
              ...(groupRoot.members || []).map(String)
            ].filter(uid => uid !== String(userId));
          }
        }

        const editor = await User.findById(userId).select("firstname lastname email");
        const editorName = `${editor?.firstname || ""} ${editor?.lastname || ""}`.trim() || editor?.email || "Someone";
        const title = "Message Edited";
        const body = `${editorName} edited a message`;

        for (const uid of notifyUserIds) {
          try {
            const u = await User.findById(uid).select("fcmToken email");
            const notification = await Notification.create({
              userId: uid,
              title,
              message: body,
              deeplink: ""
            });
            if (u?.fcmToken) {
              const pushResult = await sendFirebaseNotification(
                u.fcmToken,
                title,
                body,
                { type: "message_edited", chatId: String(chatId), messageId: String(updatedMessage._id), senderId: String(userId) }
              );
              notification.firebaseStatus = pushResult.success ? "sent" : "failed";
              await notification.save();
            }
          } catch (e) {
            console.warn("Edit notification error:", e?.message);
          }
        }
      }
    } catch (e) {
      console.warn("Edit notify flow error:", e?.message);
    }

    return successResponse(
      res,
      "Message edited successfully",
      messageResponse,
      null,
      200,
      1
    );

  } catch (error) {
    console.error("Error editing message:", error);
    return successResponse(
      res,
      "Error editing message",
      null,
      null,
      500,
      0
    );
  }
});

export const deleteChatMessagesBulk = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user?.id;
  const { messageIds, deleteFor } = req.body;

  // Validate inputs
  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
    return errorResponse(res, "messageIds array is required and must not be empty", 400);
  }

  // Validate all message IDs
  const invalidIds = messageIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length > 0) {
    return errorResponse(res, `Invalid message ID(s): ${invalidIds.join(', ')}`, 400);
  }

  // Get chat request
  const reqDoc = await ChatRequest.findById(chatId);
  if (!reqDoc) {
    return successResponse(res, "Chat id not found", null, null, 200, 0);
  }

  // Determine chat type and participants
  let chatKeyId = chatId;
  let participants = [];
  let isGroup = false;
  let groupRoot = null;

  if (reqDoc.chatType === 'individual') {
    if (reqDoc.status !== 'accepted') {
      return successResponse(res, "Chat request not accepted yet", null, null, 200, 0);
    }
    const participantList = [reqDoc.senderId.toString(), reqDoc.receiverId.toString()];
    if (!participantList.includes(String(userId))) {
      return successResponse(res, "Not a participant of this chat", null, null, 200, 0);
    }
    participants = participantList;
    chatKeyId = reqDoc._id;
  } else {
    // Group chat
    groupRoot = reqDoc.receiverId === null
      ? reqDoc
      : await ChatRequest.findOne({ _id: reqDoc.groupId, chatType: 'group', receiverId: null });

    if (!groupRoot) {
      return successResponse(res, "Group id not found", null, null, 200, 0);
    }

    const isParticipant = String(groupRoot.groupAdmin) === String(userId)
      || (groupRoot.superAdmins || []).map(String).includes(String(userId))
      || (groupRoot.members || []).map(String).includes(String(userId));

    if (!isParticipant) {
      return successResponse(res, "You are not a member of this group", null, null, 200, 0);
    }

    participants = [
      String(groupRoot.groupAdmin),
      ...(groupRoot.superAdmins || []).map(String),
      ...(groupRoot.members || []).map(String)
    ];
    chatKeyId = groupRoot._id;
    isGroup = true;
  }

  // Get conversation with populated sender information
  const convo = await ChatConversation.findOne({ chatRequestId: chatKeyId })
    .populate({ path: 'messages.sender', select: 'firstname lastname email profileimg' });

  if (!convo || !convo.messages || convo.messages.length === 0) {
    return successResponse(res, "No messages found in this chat", null, null, 200, 0);
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

  // Categorize messages and check permissions
  const messagesToDelete = [];
  const alreadyDeletedMessages = [];
  let containsOnlyOwnMessages = true;
  let containsReceivedMessages = false;

  for (const msgId of messageIds) {
    const message = convo.messages.find(m => String(m._id) === String(msgId));

    if (!message) {
      continue;
    }

    // ✅ CHECK IF MESSAGE IS ALREADY DELETED
    // - isDeleteEvery: deleted for everyone (global)
    // - deletedForMe: deleted for current user only (user-specific)
    const isAlreadyDeletedForEveryone = message.isDeleteEvery === true;
    const isAlreadyDeletedForMe = deletedForMeMap.has(msgId);
    const isAlreadyDeleted = isAlreadyDeletedForEveryone || isAlreadyDeletedForMe;
    
    if (isAlreadyDeleted) {
      alreadyDeletedMessages.push({
        id: msgId,
        message: message
      });
      continue;
    }

    // Determine message type (send/receive) for current user
    const isMessageOwner = String(message.sender?._id || message.sender) === String(userId);
    const messageType = isMessageOwner ? 'send' : 'receive';

    // Track message types for logic decisions
    if (messageType === 'receive') {
      containsReceivedMessages = true;
      containsOnlyOwnMessages = false;
    }

    messagesToDelete.push({
      id: msgId,
      message: message,
      isOwner: isMessageOwner,
      messageType: messageType
    });
  }

  // ✅ RETURN ERROR IF ALL MESSAGES ARE ALREADY DELETED
  if (messagesToDelete.length === 0 && alreadyDeletedMessages.length > 0) {
    return successResponse(
      res,
      "All selected messages have already been deleted",
      {
        alreadyDeletedCount: alreadyDeletedMessages.length,
        alreadyDeletedMessageIds: alreadyDeletedMessages.map(m => m.id)
      },
      null,
      200,
      0
    );
  }

  // ✅ RETURN WARNING IF SOME MESSAGES ARE ALREADY DELETED
  if (alreadyDeletedMessages.length > 0 && messagesToDelete.length > 0) {
    console.log(`⚠️ ${alreadyDeletedMessages.length} message(s) were already deleted, processing ${messagesToDelete.length} message(s)`);
  }

  // ✅ SMART DELETE LOGIC BASED ON MESSAGE TYPES
  let finalDeleteFor = deleteFor;

  // Case 1: Contains received messages → Force "delete for me" only
  if (containsReceivedMessages) {
    finalDeleteFor = 'me';

    // If client sent "everyone" but there are received messages, return error
    if (deleteFor === 'everyone') {
      return errorResponse(
        res,
        "You can only delete received messages for yourself, not for everyone",
        400
      );
    }
  }

  // Case 2: Only own messages → Use whatever deleteFor was sent (me or everyone)
  // Case 3: Mixed messages (own + received) → Force "delete for me" only
  else if (!containsOnlyOwnMessages && deleteFor === 'everyone') {
    finalDeleteFor = 'me';
    return errorResponse(
      res,
      "When deleting mixed messages (own + received), you can only delete for yourself",
      400
    );
  }

  // Check permissions for "delete for everyone" (only allowed for own messages)
  if (finalDeleteFor === 'everyone') {
    const nonOwnMessages = messagesToDelete.filter(m => !m.isOwner);
    if (nonOwnMessages.length > 0) {
      return errorResponse(
        res,
        "You can only delete your own messages for everyone",
        403
      );
    }
  }

  // ✅ Handle deletion in database
  const objectIdsToDelete = messagesToDelete.map(m => {
    try {
      return mongoose.Types.ObjectId.isValid(m.id) ? new mongoose.Types.ObjectId(m.id) : m.id;
    } catch {
      return m.id;
    }
  });

  let updateResult;
  const now = new Date();

  if (finalDeleteFor === 'everyone') {
    // ✅ SOFT DELETE FOR EVERYONE: Only for own messages
    updateResult = await ChatConversation.findOneAndUpdate(
      { chatRequestId: chatKeyId },
      {
        $set: {
          "messages.$[elem].isDeleteEvery": true,
          "messages.$[elem].isDeleteMe": false,
          "messages.$[elem].deletedAt": now,
          "messages.$[elem].deletedBy": userId,
          "messages.$[elem].deletedFor": 'everyone',
          "messages.$[elem].content": "This message has been deleted",
          "messages.$[elem].mediaUrl": null,
          "messages.$[elem].messageType": "text"
        }
      },
      {
        arrayFilters: [{ "elem._id": { $in: objectIdsToDelete } }],
        new: true
      }
    );
  } else {
    // ✅ DELETE FOR ME ONLY: For both own and received messages
    // Create user-specific deletion record in deletedForMe array
    const userSpecificDeletions = messagesToDelete.map(m => ({
      messageId: m.id,
      userId: userId,
      deletedAt: now,
      deleteFor: 'me'
    }));

    // Get existing deletions for this user
    const existingDeletions = convo.deletedForMe?.filter(d =>
      d.userId.toString() === userId.toString()
    ) || [];

    const existingMessageIds = new Set(existingDeletions.map(d => d.messageId.toString()));

    // Filter out messages that are already deleted for this user
    const newDeletions = userSpecificDeletions.filter(d =>
      !existingMessageIds.has(d.messageId.toString())
    );

    if (newDeletions.length > 0) {
      // ✅ DELETE FOR ME: Only add to deletedForMe array (user-specific)
      // DO NOT set isDeleteMe on the message itself (that's a global flag)
      // The retrieval logic checks deletedForMe array to filter messages per user
      updateResult = await ChatConversation.findOneAndUpdate(
        { chatRequestId: chatKeyId },
        {
          $push: {
            deletedForMe: { $each: newDeletions }
          }
          // Note: We don't update message flags for "delete for me" because:
          // - isDeleteMe is a global flag that would hide message from everyone
          // - deletedForMe array is user-specific and checked during retrieval
        },
        {
          new: true
          // Note: No arrayFilters needed here since we're only pushing to deletedForMe array,
          // not updating messages in the messages array
        }
      );
    } else {
      updateResult = convo;
    }
  }

  if (!updateResult) {
    return errorResponse(res, "Failed to delete messages", 500);
  }

  // Clear cache
  try {
    const cacheKeys = [`chat:${String(chatKeyId)}`];
    participants.forEach(participantId => {
      cacheKeys.push(`requests:${participantId}:accepted`);
    });
    await redisClient.del(cacheKeys);
  } catch (err) {
    console.warn("Redis clear error:", err.message);
  }

  // ✅ EMIT SOCKET EVENT FOR MESSAGE DELETION
  try {
    const io = getIO();
    const deletionData = {
      chatId: String(chatKeyId),
      deletedMessageIds: messagesToDelete.map(m => m.id),
      deletedCount: messagesToDelete.length,
      deletedBy: String(userId),
      deleteFor: finalDeleteFor,
      isBulk: true,
      timestamp: now,
      // NEW: Include deletion type information
      isDeleteMe: finalDeleteFor === 'me',
      isDeleteEvery: finalDeleteFor === 'everyone',
      // Include information about already deleted messages
      alreadyDeletedCount: alreadyDeletedMessages.length,
      alreadyDeletedMessageIds: alreadyDeletedMessages.map(m => m.id)
    };

    if (finalDeleteFor === 'everyone') {
      // Emit to all participants
      io.to(`chat:${String(chatKeyId)}`).emit("messagesDeleted", deletionData);
      participants.forEach(participantId => {
        io.to(`user:${participantId}`).emit("chatList:update", {
          chatId: String(chatKeyId),
          action: "messagesDeleted",
          type: isGroup ? "group" : "individual",
          deletedMessageIds: messagesToDelete.map(m => m.id),
          deleteFor: 'everyone',
          isDeleteMe: false,
          isDeleteEvery: true
        });
      });

      // Notifications to other participants for 'everyone'
      try {
        const deleter = await User.findById(userId).select("firstname lastname email");
        const deleterName = `${deleter?.firstname || ""} ${deleter?.lastname || ""}`.trim() || deleter?.email || "Someone";
        const title = "Messages Deleted";
        const body = `${deleterName} deleted ${messagesToDelete.length} message(s)`;
        for (const pid of participants.filter(p => String(p) !== String(userId))) {
          try {
            const u = await User.findById(pid).select("fcmToken email");
            const notification = await Notification.create({
              userId: pid,
              title,
              message: body,
              deeplink: ""
            });
            if (u?.fcmToken) {
              const pushResult = await sendFirebaseNotification(
                u.fcmToken,
                title,
                body,
                { type: "messages_deleted", chatId: String(chatKeyId), count: messagesToDelete.length, senderId: String(userId) }
              );
              notification.firebaseStatus = pushResult.success ? "sent" : "failed";
              await notification.save();
            }
          } catch (e) {
            console.warn("Deletion notification error:", e?.message);
          }
        }
      } catch (e) {
        console.warn("Deletion notify flow error:", e?.message);
      }
    } else {
      // Emit only to the user who deleted the messages
      io.to(`user:${userId}`).emit("messagesDeleted", deletionData);
      io.to(`user:${userId}`).emit("chatList:update", {
        chatId: String(chatKeyId),
        action: "messagesDeleted",
        type: isGroup ? "group" : "individual",
        deletedMessageIds: messagesToDelete.map(m => m.id),
        deleteFor: 'me',
        isDeleteMe: true,
        isDeleteEvery: false
      });
    }

    // Log deletion summary
    const sentCount = messagesToDelete.filter(m => m.messageType === 'send').length;
    const receivedCount = messagesToDelete.filter(m => m.messageType === 'receive').length;
    console.log(`🗑️ ${messagesToDelete.length} message(s) deleted in chat ${chatKeyId} by user ${userId}`);
    console.log(`📊 Deletion summary: ${sentCount} sent, ${receivedCount} received, deleteFor: ${finalDeleteFor}`);
    console.log(`🏷️ Database flags: isDeleteMe: ${finalDeleteFor === 'me'}, isDeleteEvery: ${finalDeleteFor === 'everyone'}`);
    if (alreadyDeletedMessages.length > 0) {
      console.log(`⚠️ ${alreadyDeletedMessages.length} message(s) were already deleted`);
    }

  } catch (err) {
    console.error("Socket emit error (message deletion):", err.message);
  }

  // ✅ FINAL RESPONSE WITH NEW STRUCTURE
  const responseData = {
    deletedCount: messagesToDelete.length,
    deletedMessageIds: messagesToDelete.map(m => m.id),
    deleteFor: finalDeleteFor,
    chatId: String(chatKeyId),
    containedReceivedMessages: containsReceivedMessages,
    // NEW: Add deletion type flags
    isDeleteMe: finalDeleteFor === 'me',
    isDeleteEvery: finalDeleteFor === 'everyone'
  };

  // Add information about already deleted messages if any
  if (alreadyDeletedMessages.length > 0) {
    responseData.alreadyDeletedCount = alreadyDeletedMessages.length;
    responseData.alreadyDeletedMessageIds = alreadyDeletedMessages.map(m => m.id); // FIXED: Changed : to =
    responseData.warning = `${alreadyDeletedMessages.length} message(s) were already deleted`;
  }

  return successResponse(
    res,
    `${messagesToDelete.length} message(s) deleted ${finalDeleteFor === 'everyone' ? 'for everyone' : 'for you'}`,
    responseData,
    null,
    200,
    1
  );
});