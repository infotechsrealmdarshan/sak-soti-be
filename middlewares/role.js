import { errorResponse } from "../utils/response.js";

export const adminOnly = (req, res, next) => {
  if (!req.user?.isAdmin) return errorResponse(res, "Only administrators can access this resource", 404);
  next();
};

// Owner or Admin (for Posts)
import Post from "../models/Post.js";
export const ownerOrAdmin = async (req, res, next) => {
  const post = await Post.findById(req.params.id);
  if (!post) return errorResponse(res, "Post not found", 404);

  const userId = req.user?._id?.toString() || req.user?.id?.toString();

  if (req.user?.isAdmin || post.author.toString() === userId) {
    req.post = post;
    return next();
  }

  return errorResponse(res, "Only the owner or administrator can access this resource", 404);
};
