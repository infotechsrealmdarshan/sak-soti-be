import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import path from "path";
import { uploadMedia, uploadLimitErrorHandler } from "../middlewares/uploadMedia.js";

/**
 * Common file upload endpoint
 * Supports: images, videos, audio, PDFs
 * Can be used for posts, profiles, or any other file upload needs
 */
export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return successResponse(res, "No file uploaded", null, null, 200, 0);
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  const ext = path.extname(req.file.originalname).toLowerCase();
  
  // Determine file type
  let fileType = "unknown";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) fileType = "image";
  else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) fileType = "video";
  else if ([".mp3", ".wav", ".aac", ".m4a", ".ogg"].includes(ext)) fileType = "audio";
  else if ([".pdf"].includes(ext)) fileType = "pdf";

  return successResponse(res, "File uploaded successfully", {
    fileUrl,
    originalName: req.file.originalname,
    fileType,
    fileSize: req.file.size,
  }, null, 200, 1);
});

// Export middleware for use in routes
export { uploadMedia, uploadLimitErrorHandler };

