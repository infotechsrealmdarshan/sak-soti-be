import mongoose from "mongoose";

const lotteryFrequencySchema = new mongoose.Schema(
  {
    lotteryId: { type: Number, required: true },
    country: { type: String, default: "us", uppercase: true },
    year: { type: Number, default: null },
    drawDateFrom: { type: String, default: null },
    drawDateTo: { type: String, default: null },
    filters: { type: mongoose.Schema.Types.Mixed, default: null },
    frequency: { type: mongoose.Schema.Types.Mixed, default: null },
    lotteryInfo: { type: mongoose.Schema.Types.Mixed, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

lotteryFrequencySchema.index(
  { lotteryId: 1, year: 1, drawDateFrom: 1, drawDateTo: 1 },
  { unique: true }
);

export default mongoose.model("LotteryFrequency", lotteryFrequencySchema);

