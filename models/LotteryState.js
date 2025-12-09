import mongoose from "mongoose";

const lotteryStateSchema = new mongoose.Schema(
  {
    country: {
      type: String,
      required: true,
      default: "us",
      uppercase: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    lotteryCount: {
      type: Number,
      default: null,
    },
    info: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

lotteryStateSchema.index({ country: 1, code: 1 }, { unique: true });

export default mongoose.model("LotteryState", lotteryStateSchema);

