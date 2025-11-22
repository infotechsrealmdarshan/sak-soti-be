export const createMessageResponse = (message, userId, chatId = null) => {
  const isDeleteEvery = message.isDeleteEvery === true;
  
  let senderInfo;
  if (message.sender?._id) {
    if (message.sender.isDeleted === true) {
      senderInfo = {
        _id: String(message.sender._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      };
    } else {
      senderInfo = {
        _id: String(message.sender._id),
        firstname: message.sender.firstname,
        lastname: message.sender.lastname,
        email: message.sender.email,
        profileimg: message.sender.profileimg
      };
    }
  } else {
    senderInfo = {
      _id: String(message.sender || userId)
    };
  }

  // Ensure chatRequestId is never "undefined"
  const chatRequestId = chatId || String(message.chatRequestId || message.chatId);
  
  const baseMessage = {
    _id: String(message._id),
    chatId: chatRequestId, // Use actual chat ID
    content: isDeleteEvery ? "This message has been deleted" : message.content,
    mediaUrl: isDeleteEvery ? null : (message.mediaUrl || null), // Always include mediaUrl
    messageType: isDeleteEvery ? "text" : (message.messageType || "text"),
    isDeleteMe: message.isDeleteMe || false,
    isDeleteEvery: isDeleteEvery,
    deletedAt: message.deletedAt || null,
    deletedBy: message.deletedBy ? String(message.deletedBy) : null,
    deletedFor: message.deletedFor || null,
    canEdit: !isDeleteEvery &&
      !message.isDeleteMe &&
      String(message.sender?._id || message.sender) === String(userId) &&
      (message.messageType === 'text' || !message.messageType) &&
      !message.mediaUrl,
    createdAt: message.createdAt,
    isEdited: message.isEdited || false,
    editedAt: message.editedAt || null,
    time: message.createdAt,
    sender: senderInfo,
    type: String(message.sender?._id || message.sender) === String(userId) ? 'send' : 'receive'
  };

  return baseMessage;
};

export const createLastMessageResponse = (message, userId, chatRequestId) => {
  if (!message) return null;

  const baseMessage = createMessageResponse(message, userId, chatRequestId);
  
  // For lastMessage in group list, we need a slightly different structure
  return {
    _id: baseMessage._id,
    chatRequestId: baseMessage.chatRequestId,
    content: baseMessage.content,
    mediaUrl: baseMessage.mediaUrl,
    messageType: baseMessage.messageType,
    sender: baseMessage.sender,
    createdAt: baseMessage.createdAt,
    deletedFor: baseMessage.deletedFor,
    isDeleteEvery: baseMessage.isDeleteEvery,
    type: baseMessage.type
  };
};

export const createDeletedForMeMap = (conversation, userId) => {
  const deletedForMeMap = new Map();
  if (conversation?.deletedForMe && Array.isArray(conversation.deletedForMe)) {
    conversation.deletedForMe.forEach(deletion => {
      if (deletion.userId && deletion.userId.toString() === userId.toString()) {
        deletedForMeMap.set(deletion.messageId.toString(), deletion);
      }
    });
  }
  return deletedForMeMap;
};

export const filterVisibleMessages = (messages, deletedForMeMap, joinedAtDate = null, userId = null) => {
  return messages
    .map(m => {
      if (!m) return null;
      
      const isDeleteMe = deletedForMeMap.has(m._id.toString());
      if (isDeleteMe) return null;

      if (joinedAtDate && new Date(m.createdAt) < joinedAtDate) {
        return null;
      }

      return m;
    })
    .filter(m => m !== null);
};