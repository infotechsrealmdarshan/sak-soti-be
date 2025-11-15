import mongoose from "mongoose";

const { Schema } = mongoose;

const groupMessageSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String },
    mediaUrl: { type: String },
    messageType: { type: String, enum: ["text", "image", "video"], default: "text" }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const chatRequestSchema = new Schema(
  {
    // Common fields for requests and group roots
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: "User" }, // null for group root
    chatType: { type: String, enum: ["individual", "group"], required: true },
    status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    groupId: { type: Schema.Types.ObjectId }, // for group: references root _id; for individual: undefined

    // Group root-only metadata (present when chatType='group' and receiverId=null)
    name: { type: String },
    groupImage: { type: String, default: null },
    groupAdmin: { type: Schema.Types.ObjectId, ref: "User" },
    superAdmins: [{ type: Schema.Types.ObjectId, ref: "User" }],
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
    pendingMembers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    messages: [groupMessageSchema],
    isSystemGroup: { type: Boolean, default: false }
  },
  { timestamps: true }
);

chatRequestSchema.index({ senderId: 1, receiverId: 1, chatType: 1, groupId: 1, status: 1 }, { name: "chat_request_compound_index" });
chatRequestSchema.index({ chatType: 1, receiverId: 1 }); // helps find group roots (receiverId=null)

const ChatRequest = mongoose.model("ChatRequest", chatRequestSchema);

export default ChatRequest;


