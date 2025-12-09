import mongoose from "mongoose";

const lotteryResultSchema = new mongoose.Schema(
  {
    lotteryId: { type: Number, required: true },
    country: { type: String, default: "us", uppercase: true },
    state: { type: String, lowercase: true, default: null },
    drawDate: { type: String, required: true }, // keep as string from API (YYYY-MM-DD)
    balls: { type: [Number], default: [] },
    ballBonus: { type: Number, default: null },
    jackpot: { type: mongoose.Schema.Types.Mixed, default: null },
    lotteryInfo: { type: mongoose.Schema.Types.Mixed, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

lotteryResultSchema.index({ lotteryId: 1, drawDate: 1 }, { unique: true });

export default mongoose.model("LotteryResult", lotteryResultSchema);

