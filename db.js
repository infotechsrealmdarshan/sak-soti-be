import mongoose from "mongoose";
import logger from "./utils/logger.js";

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    logger.log("✅ MongoDB connected successfully");
  } catch (error) {
    logger.error("❌ MongoDB connection error:", error.message);
    process.exit(1); // exit app on failure
  }
};

export default connectDB;
