import User from "../models/User.js";
import redisClient from "../config/redis.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { errorResponse, successResponse } from "../utils/response.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Post from "../models/Post.js";
import logger from "../utils/logger.js";

// Helper: clear cached users
export const clearUserCache = async () => {
  try {
    let cursor = 0;
    do {
      const { cursor: nextCursor, keys } = await redisClient.scan(cursor, {
        MATCH: "users:*",
        COUNT: 100,
      });
      cursor = nextCursor;
      if (keys.length > 0) {
        await redisClient.del(...keys); // ✅ spread keys
        logger.log(`🧹 Cleared ${keys.length} user cache entries`);
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.warn("⚠️ Redis cache clear failed:", err.message);
  }
};

// 📦 GET ALL USERS
export const getAllUsers = asyncHandler(async (req, res) => {
  let {
    page = 1,
    limit,
    search = "",
    status = "all",
    orderBy = "createdAt",
    order = "desc",
  } = req.query;

  page = parseInt(page);
  limit = limit ? parseInt(limit) : 0;

  // Build the base query
  let query = {};

  // Add search condition if provided
  if (search) {
    query.$or = [
      { firstname: { $regex: search, $options: "i" } },
      { lastname: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  // Add status filter based on your user model fields
  switch (status) {
    case "active":
      query.status = "active";
      query.isDeleted = false;
      break;

    case "inactive":
      query.status = "inactive";
      query.isDeleted = false;
      break;

    case "deleted":
      query.isDeleted = true;
      break;

    case "all":
    default:
      break;
  }

  const sortOrder = order === "asc" ? 1 : -1;
  const sortOptions = { [orderBy]: sortOrder };
  const skip = (page - 1) * (limit || 0);

  const cacheKey = `users:page=${page}&limit=${limit}&search=${search}&status=${status}&orderBy=${orderBy}&order=${order}`;

  let cachedData = null;
  try {
    const cacheValue = await redisClient.get(cacheKey);
    if (cacheValue) cachedData = JSON.parse(cacheValue);
  } catch (err) {
    logger.warn("⚠️ Redis read failed:", err.message);
  }

  let lastUpdateTime;
  try {
    lastUpdateTime = await redisClient.get("users:lastUpdateTime");
  } catch (err) {
    logger.warn("⚠️ Redis timestamp read failed:", err.message);
  }

  if (cachedData && lastUpdateTime) {
    const diff = Date.now() - parseInt(lastUpdateTime);
    if (diff < 3000) {
      logger.log("📦 Served users from Redis cache (fresh)");
      return successResponse(res, "Users retrieved successfully (from cache)", cachedData);
    }
  }

  // 🚀 3️⃣ Otherwise fetch immediately from MongoDB
  logger.log("Fetching fresh users from MongoDB...");

  const totalUsers = await User.countDocuments(query);
  const usersQuery = User.find(query).sort(sortOptions).skip(skip).select("-password");

  if (limit > 0) usersQuery.limit(limit);

  const users = await usersQuery.exec();

  // Format the response to include user status information
  const formattedUsers = users.map(user => ({
    ...user.toObject(),
    // Ensure consistent status field in response
    currentStatus: user.isDeleted ? 'deleted' : user.status
  }));

  const pagination = {
    currentPage: page,
    totalPages: limit > 0 ? Math.ceil(totalUsers / limit) : 1,
    totalItems: totalUsers,
    itemsPerPage: limit || totalUsers,
  };

  const responseData = {
    users: formattedUsers,
    pagination,
    filters: {
      appliedStatus: status,
      search: search || null
    }
  };

  // 🧠 4️⃣ Store fresh data and timestamp in Redis
  try {
    await Promise.all([
      redisClient.setEx(cacheKey, 300, JSON.stringify(responseData)), // cache for 5 min
      redisClient.set("users:lastUpdateTime", Date.now().toString())   // track freshness
    ]);
    logger.log("💾 Cached users in Redis (fresh data)");
  } catch (err) {
    logger.warn("⚠️ Redis write failed:", err.message);
  }

  return successResponse(res, "Users retrieved successfully", responseData);
});

// 📦 GET USER BY ID
export const getUserById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
    return successResponse(res, "User id not found", null, null, 200, 0);

  const cacheKey = `user:${id}`;

  // Try to get from cache
  try {
    const cachedUser = await redisClient.get(cacheKey);
    if (cachedUser) {
      logger.log("📦 Served user from Redis cache");
      return successResponse(res, "User retrieved successfully (from cache)", JSON.parse(cachedUser));
    }
  } catch (err) {
    logger.warn("⚠️ Redis read failed:", err.message);
  }

  const user = await User.findById(id).select("-password");
  if (!user)
    return successResponse(res, "User id not found", null, null, 200, 0);

  // Store in cache for 5 minutes
  try {
    await redisClient.setEx(cacheKey, 300, JSON.stringify(user));
  } catch (err) {
    logger.warn("⚠️ Redis write failed:", err.message);
  }

  return successResponse(res, "User retrieved successfully", user);
});

// ➕ CREATE USER
export const createUser = asyncHandler(async (req, res) => {
  const { firstname, lastname, email, password, isAdmin } = req.body;
  if (!firstname || !email || !password)
    return successResponse(res, "All fields are required", null, null, 200, 0);

  const existingUser = await User.findOne({ email });
  if (existingUser)
    return successResponse(res, "User already exists", null, null, 200, 0);

  const salt = await bcrypt.genSalt(12);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    firstname,
    lastname,
    email,
    password: hashedPassword,
    isAdmin: isAdmin || false,
  });

  const userResponse = user.toObject();
  delete userResponse.password;

  // Clear cached lists after creating a new user
  await clearUserCache();

  return successResponse(res, "User created successfully", userResponse, null, 200, 1);
});

// ✏️ UPDATE USER
export const updateUser = asyncHandler(async (req, res) => {
  const { firstname, lastname, email, isAdmin } = req.body;
  const profileimg = req.file ? `/uploads/${req.file.filename}` : undefined;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id))
    return successResponse(res, "User id not found", null, null, 200, 0);

  const updateData = { firstname, lastname, email };
  if (profileimg) updateData.profileimg = profileimg;
  if (typeof isAdmin !== "undefined") updateData.isAdmin = isAdmin;

  const user = await User.findByIdAndUpdate(id, updateData, { new: true }).select("-password");
  if (!user)
    return successResponse(res, "User id not found", null, null, 200, 0);

  // Clear cache for this user + user list
  await redisClient.del(`user:${id}`);
  await clearUserCache();

  return successResponse(res, "User updated successfully", user);
});

// 🚦 UPDATE STATUS
export const updateUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  if (!["active", "inactive"].includes(status))
    return successResponse(res, "Status must be Active or Inactive", null, null, 200, 0);

  if (!mongoose.Types.ObjectId.isValid(id))
    return successResponse(res, "User id not found", null, null, 200, 0);

  const user = await User.findByIdAndUpdate(id, { status }, { new: true }).select("-password");
  if (!user)
    return successResponse(res, "User id not found", null, null, 200, 0);

  // Clear cache for this user + all user lists
  await redisClient.del(`user:${id}`);
  await clearUserCache();

  return successResponse(res, "User status updated", user);
});

// ❌ DELETE USER
// ❌ SOFT DELETE USER (Admin)
export const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id))
    return successResponse(res, "User id not found", null, null, 200, 0);

  const user = await User.findById(id);
  if (!user)
    return successResponse(res, "User not found", null, null, 200, 0);

  if (user.isAdmin)
    return successResponse(res, "Admin users cannot be deleted", null, null, 200, 0);

  if (user.isDeleted)
    return successResponse(res, "User already deleted", null, null, 200, 0);

  // 🧹 Soft delete user and their posts
  user.isDeleted = true;
  user.deletedAt = new Date();
  await user.save();

  await Post.updateMany(
    { author: id },
    { $set: { isDeleted: true, deletedAt: new Date() } }
  );

  // Clear Redis cache
  try {
    await redisClient.del(`user:${id}`);
    await redisClient.del(`refreshToken:${id}`);
    await clearUserCache();
  } catch (redisError) {
    logger.warn("⚠️ Redis cache cleanup failed:", redisError.message);
  }

  return successResponse(res, "User soft-deleted successfully", null, null, 200, 1);
});