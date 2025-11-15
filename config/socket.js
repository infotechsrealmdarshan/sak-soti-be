import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import mongoose from "mongoose";

let io = null;

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
      const user = await User.findById(decoded.id).select("_id isDeleted");

      if (!user) {
        return next(new Error("Authentication error: User not found"));
      }

      // ✅ Check if user account is deleted
      if (user.isDeleted === true) {
        return next(new Error("This account has been deleted. Please contact support team to restore your account."));
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

    // Handle chat room subscription for real-time notifications
    // For GET /api/chat/{chatId} - Client should emit "joinChat" with chatId to subscribe
    // Client should then listen for "newMessage" event to receive new messages
    socket.on("joinChat", (chatId) => {
      if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
        return socket.emit('error', { message: 'Invalid chat ID' });
      }
      socket.join(`chat:${chatId}`);
    });

    // Handle leaving chat room
    socket.on("leaveChat", (chatId) => {
      if (chatId) {
        socket.leave(`chat:${chatId}`);
        console.log(`leave id: ${chatId}`);
        console.log(`👤 User ${userId} left chat room: chat:${chatId}`);
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
      console.log(`⌨️ User ${userId} stopped typing in chat: ${chatId}`);
    });

    // Listen for new messages (emitted from chatController when messages are sent)
    // Event name: "newMessage"
    // Emitted to room: chat:${chatId}
    // Payload: { messageId, chatRequestId, content, createdAt, time, type: 'receive', sender }
    // This event is automatically received by all clients in the chat:${chatId} room
    // after they have joined via "joinChat" event

    socket.on("disconnect", () => {
      console.log(`❌ User ${userId} disconnected from socket`);
    });
  });

  console.log("✅ Socket.IO initialized");
  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeSocket first.");
  }
  return io;
};