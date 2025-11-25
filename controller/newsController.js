import News from "../models/News.js";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import path from "path";
import { paginate } from "../utils/paginate.js";


export const createNews = asyncHandler(async (req, res) => {
  const { title, description, mediaUrl } = req.body;

  // ✅ Validate fields
  if (!title || !description || !mediaUrl) {
    return successResponse(
      res,
      "Title, description, and mediaUrl are required",
      null,
      null,
      200,
      0
    );
  }

  // ✅ Force mediaType (if you only allow images)
  const mediaType = "image";

  // ✅ Create news document
  const news = await News.create({
    title,
    description,
    mediaType,
    mediaUrl, // ✅ from JSON body
    author: req.user.id,
  });

  return successResponse(res, "News created successfully", news, null, 200, 1);
});


export const getAllNews = asyncHandler(async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search?.trim();
    const orderBy = req.query.orderBy || "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;

    const skip = (page - 1) * limit;

    // Build search filter
    let filter = {};

    if (search) {
      // Case-insensitive search for title, content, or author name
      filter = {
        $or: [
          { title: { $regex: search, $options: "i" } },
          { content: { $regex: search, $options: "i" } },
        ],
      };
    }

    // Get total count
    const totalNews = await News.countDocuments(filter);

    // Fetch news with author info
    const news = await News.find(filter)
      .populate("author", "firstname lastname email")
      .sort({ [orderBy]: order })
      .skip(skip)
      .limit(limit);

    // Calculate pagination
    const totalPages = Math.ceil(totalNews / limit);

    res.json({
      success: true,
      message: "News retrieved successfully",
      data: news,
      pagination: {
        currentPage: page,
        totalPages,
        totalNews,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching news:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch news",
    });
  }
});

export const getNewsById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    // Invalid ID format - return 200 with status 0 (API worked, but news id not found)
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  const news = await News.findById(id).populate("author", "firstname lastname email");
  // News not found - return 200 with status 0 (API worked, but news id not found)
  if (!news) {
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  return successResponse(res, "News retrieved successfully", news);
});


export const updateNews = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    // Invalid ID format - return 200 with status 0 (API worked, but news id not found)
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  const news = await News.findById(id);
  // News not found - return 200 with status 0 (API worked, but news id not found)
  if (!news) {
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  if (req.body.title) news.title = req.body.title;
  if (req.body.description) news.description = req.body.description;
  if (req.file) {
    news.mediaUrl = `/uploads/${req.file.filename}`;
    news.mediaType = "image"; // always image
  } else if (req.body.mediaUrl && typeof req.body.mediaUrl === "string") {
    const trimmedUrl = req.body.mediaUrl.trim();
    if (trimmedUrl) {
      news.mediaUrl = trimmedUrl;
      news.mediaType = "image";
    }
  }

  await news.save();
  return successResponse(res, "News updated successfully", news);
});


export const deleteNews = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    // Invalid ID format - return 200 with status 0 (API worked, but news id not found)
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  const news = await News.findByIdAndDelete(id);
  // News not found - return 200 with status 0 (API worked, but news id not found)
  if (!news) {
    return successResponse(res, "News id not found", null, null, 200, 0);
  }

  return successResponse(res, "News deleted successfully");
});

export const bulkDeleteNews = asyncHandler(async (req, res) => {
  // Accept either `newsIds` or `ids`
  const newsIds = req.body.newsIds || req.body.ids;

  // ✅ Validate request body
  if (!newsIds || !Array.isArray(newsIds) || newsIds.length === 0) {
    return successResponse(res, "News IDs array is required", null, null, 200, 0);
  }

  // ✅ Validate MongoDB ObjectIds
  const invalidIds = newsIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length > 0) {
    return successResponse(res, `Invalid news IDs: ${invalidIds.join(', ')}`, null, null, 200, 0);
  }

  // ✅ Find existing news documents
  const existingNews = await News.find({ _id: { $in: newsIds } });
  const foundIds = existingNews.map(n => n._id.toString());
  const notFoundIds = newsIds.filter(id => !foundIds.includes(id));

  if (existingNews.length === 0) {
    return successResponse(res, "No news found for the given IDs", null, null, 200, 0);
  }

  // ✅ Perform deletion
  const deletionResult = await News.deleteMany({ _id: { $in: foundIds } });

  // ✅ Prepare success message
  let message = `Successfully deleted ${deletionResult.deletedCount} news item(s)`;
  if (notFoundIds.length > 0) {
    message += ` (${notFoundIds.length} not found: ${notFoundIds.join(', ')})`;
  }

  // ✅ Return response
  return successResponse(
    res,
    message,
    {
      deletedCount: deletionResult.deletedCount,
      totalRequested: newsIds.length,
      notFound: notFoundIds,
    },
    null,
    200,
    1
  );
});