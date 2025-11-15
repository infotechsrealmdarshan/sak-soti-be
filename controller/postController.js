import Post from "../models/Post.js";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import path from "path";
import User from "../models/User.js";
import { notifyUsers } from "../utils/notificationHelper.js";

/* -------------------------------------------------------------------------- */
/* 🧩 COMMON POST RESPONSE FORMATTER                                           */
/* -------------------------------------------------------------------------- */
const formatPostResponse = (post) => {
  if (!post) return null;

  const formatted = post.toObject ? post.toObject() : post;

  if (formatted.author) {
    formatted.author = {
      ...formatted.author,
      isAdmin: formatted.author.isAdmin ?? false, // add isAdmin if missing
    };
  }

  return formatted;
};

const formatPostsArray = (posts) => posts.map(formatPostResponse);

/* -------------------------------------------------------------------------- */
/* 📌 CREATE POST                                                             */
/* -------------------------------------------------------------------------- */
export const createPost = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  const user = await User.findById(userId).select(
    "isSubscription isAdmin firstname lastname email country profileimg"
  );
  if (!user) return successResponse(res, "User not found", null, null, 200, 0);

  if (!user.isAdmin && !user.isSubscription) {
    return successResponse(
      res,
      "Your account does not have an active subscription. Please subscribe to access post features.",
      null,
      null,
      200,
      0
    );
  }

  // ✅ Get data from JSON body
  const { description, mediaType, mediaUrl } = req.body;

  // ✅ Validate fields
  if (!description || !mediaUrl) {
    return successResponse(res, "description, and mediaUrl are required", null, null, 200, 0);
  }

  // ✅ Create the post
  const post = await Post.create({
    description,
    mediaType,
    mediaUrl, // JSON field instead of file
    author: userId,
  });

  console.log("Created Post:", post);

  const populatedPost = await Post.findById(post._id).populate(
    "author",
    "firstname lastname email country profileimg isAdmin"
  );

  try {
    const subscribers = await User.find({
      isSubscription: true,
      isDeleted: false,
      _id: { $ne: userId },
    }).select("firstname lastname email fcmToken");

    if (subscribers.length) {
      const authorName =
        `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.email || "A creator";
      const title = "New post available";
      const message = `${authorName} just shared a new post.`;

      await notifyUsers(subscribers, title, message, {
        deeplink: `/posts/${post._id}`,
        data: {
          type: "post_new",
          postId: post._id.toString(),
          authorId: userId.toString(),
        },
      });
    }
  } catch (notifyError) {
    console.error("Post notification error:", notifyError.message);
  }

  return successResponse(
    res,
    "Post created successfully",
    formatPostResponse(populatedPost),
    null,
    200,
    1
  );
});


/* -------------------------------------------------------------------------- */
/* 📌 UPDATE POST                                                             */
/* -------------------------------------------------------------------------- */
export const updatePost = asyncHandler(async (req, res) => {
  const post = req.post;
  const userId = req.user?._id || req.user?.id;

  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return successResponse(res, "User not found", null, null, 200, 0);

  if (!user.isAdmin && !user.isSubscription) {
    return successResponse(
      res,
      "Your account does not have an active subscription. Please subscribe to edit posts.",
      null,
      null,
      200,
      0
    );
  }

  if (req.body.description) post.description = req.body.description;

  // Allow mediaType override when sent explicitly (e.g. from web uploader)
  const incomingMediaType = req.body.mediaType
    ? String(req.body.mediaType).toLowerCase()
    : undefined;
  if (incomingMediaType && ["image", "video"].includes(incomingMediaType)) {
    post.mediaType = incomingMediaType;
  }

  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if ([".jpg", ".jpeg", ".png"].includes(ext)) post.mediaType = "image";
    else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) post.mediaType = "video";
    else return successResponse(res, "Invalid media file", null, null, 200, 0);

    post.mediaUrl = `/uploads/${req.file.filename}`;
  } else if (req.body.mediaUrl && typeof req.body.mediaUrl === "string") {
    const trimmedUrl = req.body.mediaUrl.trim();
    if (trimmedUrl) {
      post.mediaUrl = trimmedUrl;
    }
  }

  await post.save();

  const updatedPost = await Post.findById(post._id).populate(
    "author",
    "firstname lastname email country profileimg isAdmin"
  );

  return successResponse(
    res,
    "Post updated successfully",
    formatPostResponse(updatedPost),
    null,
    200,
    1
  );
});

/* -------------------------------------------------------------------------- */
/* 📌 DELETE POST                                                             */
/* -------------------------------------------------------------------------- */
export const deletePost = asyncHandler(async (req, res) => {
  const post = req.post;
  const userId = req.user?._id || req.user?.id;

  const user = await User.findById(userId).select("isSubscription isAdmin");
  if (!user) return successResponse(res, "User not found", null, null, 200, 0);

  // 🔒 Check subscription (skip if admin)
  if (!user.isAdmin && !user.isSubscription) {
    return successResponse(
      res,
      "Your account does not have an active subscription. Please subscribe to delete posts.",
      null,
      null,
      200,
      0
    );
  }

  await post.deleteOne();
  return successResponse(res, "Post deleted successfully", null, null, 200, 1);
});

/* -------------------------------------------------------------------------- */
/* 📌 GET ALL POSTS                                                           */
/* -------------------------------------------------------------------------- */
export const getAllPosts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search ? req.query.search.trim() : "";
  const orderBy = req.query.orderBy || "createdAt";
  const order = req.query.order === "asc" ? 1 : -1;
  const skip = (page - 1) * limit;

  // ✅ Only fetch posts that are NOT deleted
  const query = { isDeleted: { $ne: true } };

  // ✅ Add search support if needed
  if (search) {
    query.$or = [{ description: { $regex: search, $options: "i" } }];
  }

  // ✅ Count total active (non-deleted) posts
  const totalPosts = await Post.countDocuments(query);

  // ✅ Fetch posts and populate author info
  const posts = await Post.find(query)
    .populate("author", "firstname lastname email country profileimg isAdmin isDeleted")
    .sort({ [orderBy]: order })
    .skip(skip)
    .limit(limit);

  // ✅ Extra safety: filter out posts from deleted authors (optional)
  const visiblePosts = posts.filter((post) => !post.author?.isDeleted);

  const pagination = {
    currentPage: page,
    totalPages: Math.ceil(totalPosts / limit),
    totalItems: totalPosts,
    itemsPerPage: limit,
  };

  return successResponse(
    res,
    "Posts retrieved successfully",
    formatPostsArray(visiblePosts),
    pagination,
    200,
    1
  );
});

/* -------------------------------------------------------------------------- */
/* 📌 GET POST BY ID                                                          */
/* -------------------------------------------------------------------------- */
export const getPostById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return successResponse(res, "Post id not found", null, null, 200, 0);
  }

  const post = await Post.findById(id).populate(
    "author",
    "firstname lastname email country profileimg isAdmin"
  );

  if (!post || post.isDeleted) {
    return successResponse(res, "This post has been deleted", null, null, 200, 0);
  }

  if (post.author?.isDeleted) {
    return successResponse(res, "User account has been deleted", null, null, 200, 0);
  }

  return successResponse(res, "Post retrieved successfully", formatPostResponse(post));
});

/* -------------------------------------------------------------------------- */
/* 📌 BULK DELETE POSTS (Admin or Subscribed Users)                           */
/* -------------------------------------------------------------------------- */
export const bulkDeletePosts = asyncHandler(async (req, res) => {
  const { postIds } = req.body;

  // ✅ Validate input
  if (!postIds || !Array.isArray(postIds) || postIds.length === 0) {
    return successResponse(res, "Post IDs array is required", null, null, 200, 0);
  }

  // ✅ Validate MongoDB ObjectIds
  const invalidIds = postIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length > 0) {
    return successResponse(res, `Invalid Post IDs: ${invalidIds.join(", ")}`, null, null, 200, 0);
  }

  // ✅ Check existing posts
  const existingPosts = await Post.find({ _id: { $in: postIds } });
  const foundIds = existingPosts.map((p) => p._id.toString());
  const notFoundIds = postIds.filter((id) => !foundIds.includes(id));

  if (existingPosts.length === 0) {
    return successResponse(res, "No posts found for the given IDs", null, null, 200, 0);
  }

  // ✅ Delete posts that exist
  const result = await Post.deleteMany({ _id: { $in: foundIds } });

  // ✅ Success message
  let message = `Successfully deleted ${result.deletedCount} post(s)`;
  if (notFoundIds.length > 0) {
    message += ` (${notFoundIds.length} not found: ${notFoundIds.join(", ")})`;
  }

  return successResponse(
    res,
    message,
    {
      deletedCount: result.deletedCount,
      totalRequested: postIds.length,
      notFound: notFoundIds,
    },
    null,
    200,
    1
  );
});