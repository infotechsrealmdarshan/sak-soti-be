// utils/paginate.js
import redisClient from "../config/redis.js";
import { successResponse } from "./response.js";

export const paginate = async (Model, query = {}, options = {}, req, res, message = "Data fetched successfully") => {
  const {
    page = 1,
    limit = 10,
    sort = { createdAt: -1 },
    populate = null,
    select = null,
    cacheKey = `${Model.modelName}:page:${page}:limit:${limit}`,
  } = options;

  // 🔹 Try Redis cache first
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    // Pass pagination object if exists
    return successResponse(res, `${message} (from cache)`, parsed.data || parsed, parsed.pagination);
  }

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  const totalItems = await Model.countDocuments(query);

  let mongooseQuery = Model.find(query)
    .sort(sort)
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum);

  if (populate) mongooseQuery = mongooseQuery.populate(populate);
  if (select) mongooseQuery = mongooseQuery.select(select);

  const results = await mongooseQuery;

  const pagination = {
    currentPage: pageNum,
    totalPages: Math.ceil(totalItems / limitNum),
    totalItems,
    itemsPerPage: limitNum,
    nextPage:
      pageNum * limitNum < totalItems
        ? `${req.baseUrl}${req.path}?page=${pageNum + 1}&limit=${limitNum}`
        : null,
    prevPage:
      pageNum > 1 ? `${req.baseUrl}${req.path}?page=${pageNum - 1}&limit=${limitNum}` : null,
  };

  const responseData = { data: results, pagination };

  // 🔹 Store in Redis for 10 minutes
  await redisClient.setEx(cacheKey, 600, JSON.stringify(responseData));

  return successResponse(res, message, results, pagination);
};
