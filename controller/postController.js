import Post from "../models/Post.js";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import path from "path";
import User from "../models/User.js";
import { notifyUsers } from "../utils/notificationHelper.js";
import { chatParticipantsCache } from "../config/socket.js";
import ChatRequest from "../models/ChatRequest.js";

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
    mediaUrl,
    author: userId,
  });

  const populatedPost = await Post.findById(post._id).populate(
    "author",
    "firstname lastname email country profileimg isAdmin"
  );

  // ✅ Send response FIRST so client doesn't wait for notifications
  successResponse(
    res,
    "Post created successfully",
    formatPostResponse(populatedPost),
    null,
    200,
    1
  );

  // ✅ Send notifications in background (Fire and Forget)
  setImmediate(async () => {
    try {
      // ✅ Get only subscribed users (excluding the post author)
      const subscribers = await User.find({
        isSubscription: true,
        isDeleted: false,
        _id: { $ne: userId },
      }).select("_id firstname lastname email fcmToken");

      if (subscribers.length > 0) {
        const authorName =
          `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.email || "A creator";
        const title = "New post available";
        const message = `${authorName} just shared a new post.`;

        // ✅ Use notifyUsers helper for bulk notifications
        await notifyUsers(subscribers, title, message, {
          deeplink: `/posts/${post._id}`,
          data: {
            type: "post_new",
            postId: post._id.toString(),
            authorId: userId.toString(),
          },
        });

        console.log(`✅ Post notifications sent to ${subscribers.length} subscribed users`);
      } else {
        console.log("ℹ️ No subscribed users found to send post notifications");
      }
    } catch (notifyError) {
      console.error("Post notification error:", notifyError.message);
    }
  });
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
/* 📌 GET MESSAGE FLAGS                                                       */
/* -------------------------------------------------------------------------- */
const getMessageFlags = async (req, postAuthorId, postId) => {
  try {
    // Check if user is authenticated
    if (!req.user) {
      // User is not logged in, so no message request flags
      return {
        messageRequestSent: false,
        messageRequestAccepted: false,
      };
    }

    const currentUserId = String(req.user._id || req.user.id);

    // Validate current user ID
    if (!currentUserId || currentUserId === "undefined" || !mongoose.Types.ObjectId.isValid(currentUserId)) {
      console.warn("Invalid current user ID:", currentUserId);
      return {
        messageRequestSent: false,
        messageRequestAccepted: false,
      };
    }

    console.log("<<<>>>>", postAuthorId)

    // Validate post author ID
    if (!postAuthorId || String(postAuthorId) === "undefined" || !mongoose.Types.ObjectId.isValid(String(postAuthorId))) {
      console.warn("Invalid post author ID:", postAuthorId);
      return {
        messageRequestSent: false,
        messageRequestAccepted: false,
      };
    }

    // If same user → do not show request flags
    if (currentUserId === String(postAuthorId)) {
      return {
        messageRequestSent: false,
        messageRequestAccepted: false,
      };
    }

    // Check if there's an existing chat request between current user and post author
    const chatRequest = await ChatRequest.findOne({
      chatType: "individual",
      $or: [
        {
          senderId: new mongoose.Types.ObjectId(currentUserId),
          receiverId: new mongoose.Types.ObjectId(postAuthorId)
        },
        {
          senderId: new mongoose.Types.ObjectId(postAuthorId),
          receiverId: new mongoose.Types.ObjectId(currentUserId)
        }
      ]
    });

    if (!chatRequest) {
      return {
        messageRequestSent: false,
        messageRequestAccepted: false,
      };
    }

    // Check chat request status
    const messageRequestSent = true; // Request exists
    const messageRequestAccepted = chatRequest.status === "accepted";

    return {
      messageRequestSent,
      messageRequestAccepted,
    };
  } catch (error) {
    console.error("Error checking message flags:", error);
    return {
      messageRequestSent: false,
      messageRequestAccepted: false,
    };
  }
};

/* -------------------------------------------------------------------------- */
/* 📌 GET ALL                                                         */
/* -------------------------------------------------------------------------- */
export const getAllPosts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search ? req.query.search.trim() : "";
  const orderBy = req.query.orderBy || "createdAt";
  const order = req.query.order === "asc" ? 1 : -1;
  const currentUserId = req.user?._id || req.user?.id; // Try both common patterns

  console.log("Current User ID from req.user:", currentUserId); // Debug log

  // Get ALL posts from database
  const allPosts = await Post.find({ isDeleted: { $ne: true } })
    .populate("author", "firstname lastname email country profileimg isAdmin isDeleted");

  console.log("Total posts found:", allPosts.length); // Debug log

  // Count current user's posts
  let currentUserPostCount = 0;
  if (currentUserId) {
    // Convert currentUserId to string for comparison
    const currentUserIdStr = currentUserId.toString();
    console.log("Looking for posts with author ID:", currentUserIdStr); // Debug log

    // Filter and count posts where author is the current user
    currentUserPostCount = allPosts.filter(post => {
      if (!post.author || !post.author._id) return false;

      const authorIdStr = post.author._id.toString();
      console.log(`Post ${post._id} author ID: ${authorIdStr}`); // Debug log

      return authorIdStr === currentUserIdStr;
    }).length;

    console.log("Current user post count:", currentUserPostCount); // Debug log
  } else {
    console.log("No currentUserId found in req.user"); // Debug log
  }

  // Filter posts (your existing logic)
  const filteredPosts = allPosts.filter((post) => {
    if (!post.author || post.author.isDeleted) return false;

    if (search) {
      const authorFullName = `${post.author.firstname} ${post.author.lastname}`.toLowerCase();
      const authorEmail = post.author.email.toLowerCase();
      const searchTerm = search.toLowerCase();

      const postContentMatch = post.content?.toLowerCase().includes(searchTerm);
      const authorNameMatch = authorFullName.includes(searchTerm);
      const authorEmailMatch = authorEmail.includes(searchTerm);

      return postContentMatch || authorNameMatch || authorEmailMatch;
    }

    return true;
  });

  const totalPosts = filteredPosts.length;
  const start = (page - 1) * limit;
  const end = start + limit;

  const paginatedPosts = filteredPosts
    .sort((a, b) => {
      if (order === 1) return new Date(a[orderBy]) - new Date(b[orderBy]);
      return new Date(b[orderBy]) - new Date(a[orderBy]);
    })
    .slice(start, end);

  // 💥 Add flags for each post (async) - with validation
  const postsWithFlags = await Promise.all(
    paginatedPosts.map(async (post) => {
      const formatted = formatPostResponse(post);

      // Only check flags if author exists and has valid _id
      let flags = {
        messageRequestSent: false,
        messageRequestAccepted: false
      };

      if (post.author && post.author._id && mongoose.Types.ObjectId.isValid(post.author._id)) {
        flags = await getMessageFlags(req, post.author._id, post._id);
      }

      return { ...formatted, ...flags };
    })
  );

  const pagination = {
    currentPage: page,
    totalPages: Math.ceil(totalPosts / limit),
    totalItems: totalPosts,
    itemsPerPage: limit,
    hasNextPage: page < Math.ceil(totalPosts / limit),
    hasPrevPage: page > 1,
  };

  // Return response with current user's post count
  return successResponse(
    res,
    "Posts retrieved successfully",
    {
      posts: postsWithFlags,
      currentUserPostCount // This should now show the correct count
    },
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

  const formatted = formatPostResponse(post);

  // 💥 Add dynamic flags (async) - with validation
  let flags = {
    messageRequestSent: false,
    messageRequestAccepted: false
  };

  if (post.author && post.author._id && mongoose.Types.ObjectId.isValid(post.author._id)) {
    flags = await getMessageFlags(req, post.author._id, post._id);
  }

  return successResponse(
    res,
    "Post retrieved successfully",
    { ...formatted, ...flags },
    null,
    200,
    1
  );
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