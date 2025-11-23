import Policy from "../models/Policy.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import sanitizeHtml from "sanitize-html";

/**
 * Sanitize HTML content to plain text
 */
const sanitizeContent = (contentHtml) =>
  sanitizeHtml(contentHtml, { allowedTags: [] });

/**
 * @desc Create Privacy Policy (Admin only)
 * @route POST /api/policy
 * @access Admin
 */
export const createPolicy = asyncHandler(async (req, res) => {
  const { contentHtml } = req.body;

  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  if (!contentHtml) {
    return errorResponse(res, "Content is required", 400);
  }

  const policyType = "privacy";
  const contentText = sanitizeContent(contentHtml);

  // Allow multiple versions; no uniqueness constraint

  const policy = await Policy.create({
    policyType,
    contentHtml,
    contentText,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  return successResponse(res, "Privacy Policy created successfully", policy);
});

/**
 * @desc Update Privacy Policy by ID (Admin only)
 * @route PUT /api/policy/:id
 * @access Admin
 */
export const updatePolicy = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { contentHtml } = req.body;

  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  if (!contentHtml) {
    return errorResponse(res, "Content is required", 400);
  }

  // Find only privacy-type policy
  const policy = await Policy.findOne({ _id: id, policyType: "privacy" });
  if (!policy) {
    return errorResponse(res, "Privacy Policy not found", 404);
  }

  policy.contentHtml = contentHtml;
  policy.contentText = sanitizeContent(contentHtml);
  policy.updatedAt = new Date();
  policy.updatedBy = req.user._id;

  await policy.save();

  return successResponse(res, "Privacy Policy updated successfully", policy);
});

/**
 * @desc Get Latest Privacy Policy
 * @route GET /api/policy
 * @access Public
 */
export const getLatestPolicy = asyncHandler(async (req, res) => {
  const policy = await Policy.findOne({ policyType: "privacy" }).sort({
    updatedAt: -1,
  });

  if (!policy) {
    return errorResponse(res, "Privacy Policy not found", 404);
  }

  return successResponse(res, "Privacy Policy fetched successfully", policy);
});

/**
 * @desc Get Privacy Policy by ID
 * @route GET /api/policy/:id
 * @access Public
 */
export const getPolicyById = asyncHandler(async (req, res) => {
  const policy = await Policy.findOne({
    _id: req.params.id,
    policyType: "privacy",
  });

  if (!policy) {
    return errorResponse(res, "Privacy Policy not found", 404);
  }

  return successResponse(res, "Privacy Policy fetched successfully", policy);
});

/**
 * @desc Delete Privacy Policy (Admin only)
 * @route DELETE /api/policy/:id
 * @access Admin
 */
export const deletePolicy = asyncHandler(async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  const policy = await Policy.findOne({
    _id: req.params.id,
    policyType: "privacy",
  });

  if (!policy) {
    return errorResponse(res, "Privacy Policy not found", 404);
  }

  await policy.deleteOne();

  return successResponse(res, "Privacy Policy deleted successfully", null);
});
