import mongoose from "mongoose";

const { Schema } = mongoose;

const convoMessageSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String },
    mediaUrl: { type: String },
    messageType: { type: String, enum: ["text", "image", "video", "audio", "pdf"], default: "text" },
    time: { type: Date },
    // NEW: Separate deletion flags
    isDeleteMe: { type: Boolean, default: false },
    isDeleteEvery: { type: Boolean, default: false },

    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
    deletedFor: { type: String, enum: ["me", "everyone"], default: null },

    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false, currentTime: () => new Date() } }
);

const chatConversationSchema = new Schema(
  {
    chatRequestId: { type: Schema.Types.ObjectId, ref: "ChatRequest", required: true, unique: true },
    chatType: { type: String, enum: ["individual", "group"], required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    messages: [convoMessageSchema],
    // Per-user last read timestamp to compute unread counts
    lastReadAtByUser: { type: Map, of: Date, default: {} },
    // Track when each participant joined (used to hide history for late joiners)
    joinedAtByUser: { type: Map, of: Date, default: {} },

    // Keep deletedForMe for backward compatibility, but we'll use the new flags primarily
    deletedForMe: [{
      messageId: { type: Schema.Types.ObjectId, required: true },
      userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
      deletedAt: { type: Date, default: Date.now },
      deleteFor: { type: String, enum: ["me"], default: "me" }
    }]
  },
  {
    timestamps: {
      currentTime: () => new Date()
    }
  }
);

chatConversationSchema.index({ chatRequestId: 1 });

const ChatConversation = mongoose.model("ChatConversation", chatConversationSchema);

export default ChatConversation;