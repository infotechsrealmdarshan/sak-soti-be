import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import mongoose from "mongoose";
import ChatRequest from "../models/ChatRequest.js"; // Add this import
import ChatConversation from "../models/ChatConversation.js"; // Add this import

let io = null;
const chatParticipantsCache = new Map();

const getChatParticipantIds = async (chatId) => {
  const cacheKey = String(chatId);
  const cached = chatParticipantsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 60_000) {
    return cached.participants;
  }

  const chatRequest = await ChatRequest.findById(chatId).select(
    "chatType senderId receiverId groupAdmin superAdmins members"
  );
  if (!chatRequest) return [];

  let participants = [];
  if (chatRequest.chatType === "individual") {
    participants = [
      String(chatRequest.senderId),
      String(chatRequest.receiverId),
    ];
  } else {
    participants = [
      String(chatRequest.groupAdmin),
      ...(chatRequest.superAdmins || []).map(String),
      ...(chatRequest.members || []).map(String),
    ];
  }

  const uniqueParticipants = Array.from(
    new Set(participants.filter(Boolean))
  );
  chatParticipantsCache.set(cacheKey, {
    participants: uniqueParticipants,
    cachedAt: Date.now(),
  });
  return uniqueParticipants;
};

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const authHeader = socket.handshake.headers?.authorization;
      const token = socket.handshake.auth?.token ||
        (authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null);

      if (!token) {
        return next(new Error("Authentication error: No token provided"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("_id");

      if (!user) {
        return next(new Error("Authentication error: User not found"));
      }

      socket.userId = decoded.id;
      next();
    } catch (error) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;
    console.log(`✅ User ${userId} connected to socket`);

    // Join room for user ID to receive messages
    socket.join(`user:${userId}`);

    // Auto-join all chat rooms the user is a participant of
    (async () => {
      try {
        const userRooms = await ChatConversation.find({ participants: String(userId) })
          .select("chatRequestId");

        userRooms
          .filter(room => room?.chatRequestId)
          .forEach(room => {
            const roomId = String(room.chatRequestId);
            socket.join(`chat:${roomId}`);
          });

        console.log(
          `🏠 User ${userId} auto-joined ${userRooms.length} chat rooms on connect`
        );
      } catch (error) {
        console.error("⚠️ Failed to auto-join chat rooms:", error.message);
      }
    })();

    socket.on("joinChat", (data) => {
      console.log("🎯 Backend received joinChat with data:", data);

      // Handle both object and direct parameter
      const chatId = typeof data === 'object' ? data.chatId : data;

      if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
        console.log("❌ Invalid chat ID:", chatId);
        return socket.emit('error', { message: 'Invalid chat ID' });
      }

      socket.join(`chat:${chatId}`);
      console.log(`✅ User ${userId} joined chat room: chat:${chatId}`);

      // Verify room joining
      console.log(`🏠 User ${userId} rooms after join:`, Array.from(socket.rooms));
    });

    // Handle leaving chat room
    socket.on("leaveChat", (chatId) => {
      if (chatId) {
        socket.leave(`chat:${chatId}`);
        console.log(`👤 User ${userId} left chat room: chat:${chatId}`);
      }
    });

    // ✅ NEW: Handle sendMessage event from frontend
    socket.on("sendMessage", async (data) => {
      try {
        const { chatId, message, senderId } = data;
        console.log("📤 Backend received sendMessage:", { chatId, message, senderId });

        if (!chatId || !message || !senderId) {
          return socket.emit('error', { message: 'Missing required fields' });
        }

        // Validate MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(chatId)) {
          return socket.emit('error', { message: 'Invalid chat ID' });
        }

        // Validate user is in the chat
        const chatRequest = await ChatRequest.findById(chatId);
        if (!chatRequest) {
          return socket.emit('error', { message: 'Chat not found' });
        }

        // Check if user is participant (for individual chats)
        if (chatRequest.chatType === 'individual') {
          const participants = [
            chatRequest.senderId.toString(), 
            chatRequest.receiverId.toString()
          ];
          if (!participants.includes(senderId)) {
            return socket.emit('error', { message: 'Not a participant of this chat' });
          }
        }

        // Check if user is member (for group chats)
        if (chatRequest.chatType === 'group') {
          const isParticipant = 
            String(chatRequest.groupAdmin) === String(senderId) ||
            (chatRequest.superAdmins || []).map(String).includes(String(senderId)) ||
            (chatRequest.members || []).map(String).includes(String(senderId));
          
          if (!isParticipant) {
            return socket.emit('error', { message: 'Not a member of this group' });
          }
        }

        // Get sender info
        const sender = await User.findById(senderId).select("firstname lastname email profileimg");
        if (!sender) {
          return socket.emit('error', { message: 'Sender not found' });
        }

        // Create message object for real-time broadcast
        const timestamp = new Date().toISOString();
        const messageData = {
          _id: `temp-${Date.now()}`,
          chatId: String(chatId),
          chatRequestId: String(chatId),
          content: message,
          messageType: 'text',
          createdAt: timestamp,
          time: timestamp,
          sender: {
            _id: String(sender._id),
            firstname: sender.firstname,
            lastname: sender.lastname,
            email: sender.email,
            profileimg: sender.profileimg
          },
          type: 'receive'
        };

        // Emit to all users in the chat room (including sender for consistency)
        io.to(`chat:${chatId}`).emit("newMessage", messageData);
        
        // Also emit chat list update to all participants
        const chatListUpdateData = {
          chatId: String(chatId),
          action: "newMessage",
          lastMessage: {
            ...messageData,
            type: String(sender._id) === String(userId) ? 'send' : 'receive'
          }
        };

        // For individual chats, notify both participants
        if (chatRequest.chatType === 'individual') {
          const otherUserId = String(chatRequest.senderId) === String(senderId) 
            ? String(chatRequest.receiverId)
            : String(chatRequest.senderId);
          
          io.to(`user:${senderId}`).emit("chatList:update", {
            ...chatListUpdateData,
            lastMessage: { ...chatListUpdateData.lastMessage, type: 'send' }
          });
          
          io.to(`user:${otherUserId}`).emit("chatList:update", {
            ...chatListUpdateData,
            lastMessage: { ...chatListUpdateData.lastMessage, type: 'receive' }
          });
        } 
        // For group chats, notify all members
        else if (chatRequest.chatType === 'group') {
          const allMemberIds = [
            String(chatRequest.groupAdmin),
            ...(chatRequest.superAdmins || []).map(String),
            ...(chatRequest.members || []).map(String)
          ];

          allMemberIds.forEach(memberId => {
            const messageType = String(memberId) === String(senderId) ? 'send' : 'receive';
            io.to(`user:${memberId}`).emit("chatList:update", {
              ...chatListUpdateData,
              lastMessage: { ...chatListUpdateData.lastMessage, type: messageType }
            });
          });
        }

        console.log(`✅ Message broadcasted to chat:${chatId} from user:${senderId}`);

      } catch (error) {
        console.error("❌ Error in sendMessage handler:", error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ✅ NEW: Handle getMessages event (for real-time message fetching)
    socket.on("getMessages", async (data) => {
      try {
        const { chatId, page = 1, limit = 50 } = data;
        console.log("📥 Backend received getMessages:", { chatId, page, limit });

        if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
          return socket.emit('error', { message: 'Invalid chat ID' });
        }

        // Here you would typically fetch messages from database
        // For now, we'll just acknowledge the request
        socket.emit("messagesFetched", { 
          chatId, 
          page, 
          limit,
          message: "Messages fetch request received" 
        });

      } catch (error) {
        console.error("❌ Error in getMessages handler:", error);
        socket.emit('error', { message: 'Failed to fetch messages' });
      }
    });

    // NEW: Listen for mark as read events from frontend
    socket.on("markMessagesAsRead", (data) => {
      const { chatId } = data;
      if (chatId) {
        // Notify other participants that this user read messages
        socket.to(`chat:${chatId}`).emit("messagesRead", {
          chatId: String(chatId),
          userId: String(userId),
          readAt: new Date()
        });
        console.log(`📖 User ${userId} marked messages as read in chat: ${chatId}`);
      }
    });

    // ✅ TYPING INDICATOR: Listen for typing start events
    socket.on("typing:start", async (data) => {
      const { chatId } = data;
      if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
        return socket.emit('error', { message: 'Invalid chat ID for typing' });
      }

      try {
        // Get user info for typing indicator
        const user = await User.findById(userId).select("firstname lastname email profileimg");
        if (!user) return;

        const typingData = {
          chatId: String(chatId),
          userId: String(userId),
          user: {
            _id: String(user._id),
            firstname: user.firstname,
            lastname: user.lastname,
            email: user.email,
            profileimg: user.profileimg
          },
          isTyping: true
        };

        // Emit to chat room (excluding the sender)
        socket.to(`chat:${chatId}`).emit("userTyping", typingData);
        try {
          const participantIds = await getChatParticipantIds(chatId);
          participantIds
            .filter((participantId) => participantId !== String(userId))
            .forEach((participantId) => {
              io.to(`user:${participantId}`).emit("userTyping", typingData);
            });
        } catch (err) {
          console.error("Error broadcasting typing:start to participants:", err.message);
        }
        console.log(`⌨️ User ${userId} started typing in chat: ${chatId}`);
      } catch (error) {
        console.error("Error handling typing:start:", error.message);
      }
    });

    // ✅ TYPING INDICATOR: Listen for typing stop events
    socket.on("typing:stop", (data) => {
      const { chatId } = data;
      if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
        return socket.emit('error', { message: 'Invalid chat ID for typing' });
      }

      const typingData = {
        chatId: String(chatId),
        userId: String(userId),
        isTyping: false
      };

      // Emit to chat room (excluding the sender)
      socket.to(`chat:${chatId}`).emit("userTyping", typingData);
      getChatParticipantIds(chatId).then((participantIds) => {
        participantIds
          .filter((participantId) => participantId !== String(userId))
          .forEach((participantId) => {
            io.to(`user:${participantId}`).emit("userTyping", typingData);
          });
      }).catch((err) => {
        console.error("Error broadcasting typing:stop to participants:", err.message);
      });
      console.log(`⌨️ User ${userId} stopped typing in chat: ${chatId}`);
    });

    // ✅ NEW: Handle connection confirmation
    socket.on("connected", (data) => {
      console.log("✅ Client confirmed connection:", data);
      socket.emit("connected", { 
        message: "Successfully connected to server",
        userId: String(userId),
        socketId: socket.id
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`❌ User ${userId} disconnected from socket. Reason:`, reason);
    });
  });

  console.log("✅ Socket.IO initialized with enhanced event handlers");
  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeSocket first.");
  }
  return io;
};