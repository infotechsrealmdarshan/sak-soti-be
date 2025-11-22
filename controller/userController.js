import jwt from "jsonwebtoken";
import path from "path";
import User from "../models/User.js";
import redisClient from "../config/redis.js";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import authHelper from "../utils/authHelper.js";
import { verifyFirebaseToken } from "../config/firebase.js";
import Post from "../models/Post.js";
import { createStripeCustomer, validateStripeCustomer } from "../utils/stripeHelper.js";
import { checkAndExpireSubscription } from "../utils/subscriptionCron.js";

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;


export const registerUser = asyncHandler(async (req, res) => {
  const { firstname, lastname, email, password, profileimg, fcmToken, country } = req.body;

  if (!passwordRegex.test(password)) {
    return successResponse(
      res,
      "Password must be at least 8 characters long and include one uppercase letter, one lowercase letter, one number, and one special character.",
      null,
      null,
      200,
      0
    );
  }

  let user = await User.findOne({ email });
  if (user) {
    if (user.isDeleted) {
      return successResponse(
        res,
        "This account was previously deleted. Please contact support to restore your account.",
        null,
        null,
        200,
        0
      );
    }
    return successResponse(res, "User already exists", null, null, 200, 0);
  }

  user = await User.create({ firstname, lastname, email, password, profileimg, fcmToken, country });

  // 🟢 Create Stripe customer and attach ID
  try {
    await createStripeCustomer(user);
  } catch (err) {
    console.error("⚠️ Stripe customer creation failed at registration:", err.message);
  }

  const accessToken = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  // Try to cache user in Redis, but don't fail if Redis is unavailable
  try {
    await redisClient.setEx(`user:${user._id}`, 3600, JSON.stringify(user));
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  // Exclude password from response
  const userResponse = user.toObject();
  delete userResponse.password;

  return successResponse(res, "Registration successful", { accessToken, user: userResponse }, null, 200, 1);
});


export const loginUser = asyncHandler(async (req, res) => {
  const { email, password, fcmToken } = req.body;
  const user = await User.findOne({ email }).select("+password");

  // User not found - return 200 with status 0 (API worked, but user not registered)
  if (!user) {
    return successResponse(res, "User not found", null, null, 200, 0);
  }

  if (user.isDeleted) {
    return successResponse(
      res,
      "This account has been deleted. Please contact support to restore your account.",
      null,
      null,
      200,
      0
    );
  }

  const match = await user.comparePassword(password);

  // Password doesn't match - return 200 with status 0 (API worked, but credentials invalid)
  if (!match) {
    return successResponse(res, "Invalid credentials", null, null, 200, 0);
  }

  if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET is not configured in environment variables");
    return errorResponse(res, "Server configuration error", 500);
  }

  try {
    const isValidCustomer = await validateStripeCustomer(user.stripeCustomerId);
    if (!isValidCustomer) {
      console.log(`⚠️ Stripe customer invalid or missing for ${user.email}. Creating new...`);
      await createStripeCustomer(user);
    }
  } catch (stripeError) {
    console.error("❌ Stripe customer validation/creation failed:", stripeError.message);
  }

  // Generate access and refresh tokens using helper functions
  const accessToken = authHelper.generateAccessToken(user);
  const refreshToken = authHelper.generateRefreshToken(user);
  const refreshTokenExpiry = process.env.JWT_REFRESH_TOKEN_EXPIRY || '30d';

  // Update push token if provided
  try {
    if (fcmToken && fcmToken !== user.fcmToken) {
      user.fcmToken = fcmToken;
      await user.save();
    }
  } catch (saveErr) {
    console.warn("⚠️ Failed to update fcmToken:", saveErr.message);
  }

  // Store refresh token in Redis with matching TTL
  try {
    // Parse expiry time to seconds for Redis (setEx expects seconds)
    const refreshTokenExpiryMs = authHelper.parseExpiry(refreshTokenExpiry);
    const refreshTokenExpirySeconds = Math.floor(refreshTokenExpiryMs / 1000);
    await redisClient.setEx(`refreshToken:${user._id}`, refreshTokenExpirySeconds, refreshToken);
    await redisClient.setEx(`user:${user._id}`, 3600, JSON.stringify(user));
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  // Exclude password from response
  const userResponse = user.toObject();
  delete userResponse.password;

  // Success - return 200 with status 1 (user found and login successful)
  return successResponse(res, "Login successful", {
    accessToken,
    user: userResponse
  }, null, 200, 1);
});


export const getProfile = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Fetch user
  let user = await User.findById(userId);

  if (!user) {
    return successResponse(res, "User id not found", null, null, 200, 0);
  }

  // Check subscription expiry
  const { expired, user: updatedUser } = await checkAndExpireSubscription(user);
  user = updatedUser;

  // Convert user and remove sensitive fields
  const userResponse = user.toObject();
  delete userResponse.password;
  delete userResponse.firebaseToken;

  // Update cache
  try {
    await redisClient.setEx(`user:${userId}`, 3600, JSON.stringify(userResponse));
    if (expired) {
      console.log(`✅ Cache updated after subscription expiration for user: ${user.email}`);
    }
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  return successResponse(
    res,
    expired ? "Subscription expired, updated profile" : "Profile retrieved",
    { user: userResponse }
  );
});

export const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  // ✅ Handle missing body safely
  const { firstname, lastname, country } = req.body || {};

  const updateData = {};

  if (firstname) updateData.firstname = firstname;
  if (lastname) updateData.lastname = lastname;
  if (country !== undefined) updateData.country = country;

  // ✅ Handle uploaded image (via form-data)
  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      updateData.profileimg = `/uploads/${req.file.filename}`;
    } else {
      return successResponse(res, "Invalid profile image format", null, null, 200, 0);
    }
  }

  const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
    new: true,
  });

  if (!updatedUser) {
    return successResponse(res, "User id not found", null, null, 200, 0);
  }

  const userResponse = updatedUser.toObject();
  delete userResponse.password;

  try {
    await redisClient.setEx(`user:${userId}`, 3600, JSON.stringify(userResponse));
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  return successResponse(res, "Profile updated successfully", { user: userResponse });
});


export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return successResponse(res, "Email is required", null, null, 200, 0);

  const user = await User.findOne({ email });
  // User not found - return 200 with status 0 (API worked, but user not found)
  if (!user) {
    return successResponse(res, "User id not found", null, null, 200, 0);
  }

  if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET is not configured in environment variables");
    return errorResponse(res, "Server configuration error", 500);
  }

  const resetToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

  return successResponse(res, "Password reset token generated", { resetToken });
});


export const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword)
    return successResponse(res, "Token and new password are required", null, null, 200, 0);

  if (!passwordRegex.test(newPassword)) {
    return successResponse(
      res,
      "Password must be at least 8 characters long and include one uppercase letter, one lowercase letter, one number, and one special character.",
      null,
      null,
      200,
      0
    );
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return successResponse(res, "Invalid or expired token", null, null, 200, 0);
  }

  const user = await User.findById(payload.id).select("+password");
  // User not found - return 200 with status 0 (API worked, but user id not found)
  if (!user) {
    return successResponse(res, "User id not found", null, null, 200, 0);
  }

  user.password = newPassword; // Will be automatically hashed by User model pre-save hook
  await user.save();

  // Try to clear user from Redis cache, but don't fail if Redis is unavailable
  try {
    await redisClient.del(`user:${user._id}`);
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  return successResponse(res, "Password changed successfully");
});


export const updateStatus = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { status } = req.body;

  if (!["active", "inactive"].includes(status)) {
    return successResponse(res, "Status must be Active or Inactive", null, null, 200, 0);
  }

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { status },
    { new: true }
  ).select("-password");

  // User not found - return 200 with status 0 (API worked, but user id not found)
  if (!updatedUser) {
    return successResponse(res, "User id not found", null, null, 200, 0);
  }

  try {
    await redisClient.setEx(`user:${userId}`, 3600, JSON.stringify(updatedUser));
  } catch (redisError) {
    console.warn("⚠️ Redis cache failed (non-critical):", redisError.message);
  }

  return successResponse(res, "Status updated successfully", updatedUser);
});

/**
 * Google Authentication using Firebase
 * Accepts Firebase ID token from frontend, verifies it, and logs in/registers user
 */
export const googleAuth = asyncHandler(async (req, res) => {
  const { idToken } = req.body;

  console.log("🔐 Google Auth - ID Token received:", idToken ? `Present (length: ${idToken.length})` : "Missing");

  if (!idToken) {
    return errorResponse(res, "ID Token missing", 400);
  }

  // STEP 1: Verify Firebase ID Token
  const result = await verifyFirebaseToken(idToken);

  console.log("🔐 Firebase verification result:", {
    success: result.success,
    error: result.error,
    message: result.message,
    email: result.email
  });

  if (result.error || !result.success) {
    console.error("❌ Firebase token verification failed:", result.message);
    return errorResponse(res, result.message || "Invalid Firebase ID Token", 401);
  }

  const { email, name, picture, uid } = result; // ✅ Get uid from result

  if (!email) {
    console.error("❌ Firebase token missing email");
    return errorResponse(res, "Firebase token missing email", 400);
  }

  console.log("✅ Firebase token verified for email:", email);

  // Split name
  let firstname = "";
  let lastname = "";

  if (name) {
    const parts = name.trim().split(" ");
    firstname = parts[0];
    lastname = parts.slice(1).join(" ");
  } else {
    firstname = email.split("@")[0];
  }

  // STEP 2: Check or create user
  let user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    console.log("👤 Creating new user for email:", email);
    
    // ✅ CREATE USER WITH firebaseToken TO BYPASS PASSWORD REQUIREMENT
    user = await User.create({
      firstname,
      lastname,
      email: email.toLowerCase(),
      profileimg: picture || "/uploads/default.png",
      firebaseToken: uid, // ✅ THIS IS CRITICAL - sets firebaseToken to bypass password validation
    });
    console.log("✅ New Google auth user created:", user._id);
  } else {
    console.log("👤 Existing user found:", user._id);
    // Update profile picture if changed and set firebaseToken
    if (picture && picture !== user.profileimg) {
      user.profileimg = picture;
    }
    // ✅ Ensure firebaseToken is set for existing users
    if (!user.firebaseToken) {
      user.firebaseToken = uid;
    }
    await user.save();
    console.log("🔄 Updated user profile image and firebaseToken");
  }

  // STEP 3: Issue tokens
  const accessToken = authHelper.generateAccessToken(user);
  const refreshToken = authHelper.generateRefreshToken(user);

  const refreshTokenExpiry = process.env.JWT_REFRESH_TOKEN_EXPIRY || "30d";
  const refreshTokenExpiryMs = authHelper.parseExpiry(refreshTokenExpiry);
  const refreshTokenExpirySeconds = Math.floor(refreshTokenExpiryMs / 1000);

  // STEP 4: Save refresh token in Redis
  try {
    await redisClient.setEx(
      `refreshToken:${user._id}`,
      refreshTokenExpirySeconds,
      refreshToken
    );
    console.log("✅ Refresh token stored in Redis");
  } catch (err) {
    console.warn("⚠️ Redis save failed:", err.message);
  }

  // STEP 5: Clean user response
  const userResponse = user.toObject();
  delete userResponse.password;
  delete userResponse.firebaseToken; // Remove sensitive data

  console.log("✅ Google authentication successful for user:", user.email);

  return successResponse(
    res,
    "Google login successful",
    {
      accessToken,
      user: userResponse,
    },
    null,
    200,
    1
  );
});

export const refreshToken = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return successResponse(res, "Token is required", null, null, 400, 0);
  }

  if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET is not configured in environment variables");
    return errorResponse(res, "Server configuration error", 500);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return successResponse(res, "Invalid or expired refresh token", null, null, 401, 0);
    }
    return successResponse(res, "Invalid or expired refresh token", null, null, 401, 0);
  }

  // Verify refresh token exists in Redis (optional security check)
  try {
    const storedToken = await redisClient.get(`refreshToken:${decoded.id}`);
    if (!storedToken || storedToken !== token) {
      return successResponse(res, "Invalid or expired refresh token", null, null, 401, 0);
    }
  } catch (redisError) {
    // If Redis is unavailable, continue without validation (non-critical)
    console.warn("⚠️ Redis verification failed (non-critical):", redisError.message);
  }

  // Verify user still exists
  const user = await User.findById(decoded.id);
  if (!user) {
    return successResponse(res, "User not found", null, null, 401, 0);
  }

  // Generate new access token
  const newAccessToken = authHelper.generateAccessToken({ _id: decoded.id });

  return successResponse(res, "New access token generated", {
    accessToken: newAccessToken,
  }, null, 200, 1);
});


export const logoutUser = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return successResponse(res, "User not authenticated", null, null, 200, 0);
  }

  try {
    // Clear user's push token on logout
    try {
      await User.findByIdAndUpdate(userId, { fcmToken: null });
    } catch (updateErr) {
      console.warn("⚠️ Failed to clear fcmToken on logout:", updateErr.message);
    }
    await redisClient.del(`refreshToken:${userId}`);
    await redisClient.del(`user:${userId}`);
    return successResponse(res, "Logout successful", null, null, 200, 1);
  } catch (redisError) {
    console.warn("⚠️ Redis logout cleanup failed:", redisError.message);
    return successResponse(res, "Logout successful (cache cleanup failed)", null, null, 200, 1);
  }
});

/**
 * Bulk delete users (Admin only)
 */
export const bulkDeleteUsers = asyncHandler(async (req, res) => {
  const { userIds } = req.body;

  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
    return successResponse(res, "User IDs array is required", null, null, 200, 0);
  }

  const invalidIds = userIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length > 0) {
    return successResponse(res, `Invalid user IDs: ${invalidIds.join(', ')}`, null, null, 200, 0);
  }

  const currentUserId = req.user?.id;
  if (userIds.includes(currentUserId)) {
    return successResponse(res, "Cannot delete your own account", null, null, 200, 0);
  }

  const usersToDelete = await User.find({ _id: { $in: userIds } });
  const foundUserIds = usersToDelete.map(user => user._id.toString());

  const nonExistentIds = userIds.filter(id => !foundUserIds.includes(id));
  if (nonExistentIds.length > 0) {
    return successResponse(res, `Users not found: ${nonExistentIds.join(', ')}`, null, null, 200, 0);
  }

  const adminUsers = usersToDelete.filter(user => user.isAdmin === true);
  if (adminUsers.length > 0) {
    const adminEmails = adminUsers.map(user => user.email);
    return successResponse(
      res,
      `Cannot delete admin users: ${adminEmails.join(', ')}`,
      null,
      null,
      200,
      0
    );
  }

  const nonAdminUserIds = usersToDelete
    .filter(user => user.isAdmin !== true)
    .map(user => user._id);

  if (nonAdminUserIds.length === 0) {
    return successResponse(res, "No non-admin users to delete", null, null, 200, 0);
  }

  // ✅ STEP 1: Soft delete posts by those users
  const deletedPostsResult = await Post.updateMany(
    { author: { $in: nonAdminUserIds }, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date() } }
  );

  // ✅ STEP 2: Soft delete the users themselves
  const userSoftDeleteResult = await User.updateMany(
    { _id: { $in: nonAdminUserIds }, isAdmin: { $ne: true }, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date() } }
  );

  // 🧠 STEP 3: Clear Redis cache for soft-deleted users
  try {
    const deletePromises = nonAdminUserIds.map(userId =>
      redisClient.del(`user:${userId}`)
    );
    const refreshDeletePromises = nonAdminUserIds.map(userId =>
      redisClient.del(`refreshToken:${userId}`)
    );
    await Promise.all([...deletePromises, ...refreshDeletePromises]);
    console.log(`🧹 Cleared Redis cache for ${nonAdminUserIds.length} users`);
  } catch (redisError) {
    console.warn("⚠️ Redis cache cleanup failed (non-critical):", redisError.message);
  }

  // 📝 Response message
  let message = `Soft-deleted ${userSoftDeleteResult.modifiedCount} user(s)`;
  if (deletedPostsResult.modifiedCount > 0) {
    message += ` and ${deletedPostsResult.modifiedCount} post(s) created by them`;
  }
  if (adminUsers.length > 0) {
    message += ` (Skipped ${adminUsers.length} admin user(s))`;
  }

  return successResponse(
    res,
    message,
    {
      softDeletedUsers: userSoftDeleteResult.modifiedCount,
      softDeletedPosts: deletedPostsResult.modifiedCount,
      totalRequested: userIds.length,
      skippedAdmins: adminUsers.length
    },
    null,
    200,
    1
  );
});

/**
 * Soft delete (deactivate) a user's own account
 * Requires valid JWT authentication
 */
export const deleteMyAccount = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return successResponse(res, "User not authenticated", null, null, 401, 0);
  }

  // Fetch user
  const user = await User.findById(userId);
  if (!user) {
    return successResponse(res, "User not found", null, null, 404, 0);
  }

  // Prevent double deletion
  if (user.isDeleted) {
    return successResponse(res, "Account already deleted", null, null, 200, 0);
  }

  if (user.stripeCustomerId) {
    try {
      await stripe.customers.del(user.stripeCustomerId);
      console.log(`✅ Stripe customer deleted: ${user.stripeCustomerId}`);
    } catch (stripeError) {
      console.error("⚠️ Failed to delete Stripe customer:", stripeError.message);
    }
  } else {
    console.log(`ℹ️ No Stripe customer found for user ${user.email}`);
  }

  // Soft delete user
  user.isDeleted = true;
  user.deletedAt = new Date();
  await user.save();

  // Soft delete user’s posts as well (optional)
  await Post.updateMany(
    { author: userId, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date() } }
  );

  // Clear Redis cache
  try {
    await redisClient.del(`user:${userId}`);
    await redisClient.del(`refreshToken:${userId}`);
  } catch (redisError) {
    console.warn("⚠️ Redis cleanup failed (non-critical):", redisError.message);
  }

  return successResponse(res, "Account deleted successfully", null, null, 200, 1);
});
