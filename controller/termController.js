import Policy from "../models/Policy.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";
import sanitizeHtml from "sanitize-html";

/**
 * Sanitize HTML → plain text
 */
const sanitizeContent = (contentHtml) => sanitizeHtml(contentHtml, { allowedTags: [] });

/**
 * @desc Create or Update Terms & Conditions (Admin only)
 * @route POST /api/terms
 * @access Admin
 */
export const createOrUpdateTerms = asyncHandler(async (req, res) => {
  const { contentHtml } = req.body;

  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  if (!contentHtml) {
    return errorResponse(res, "Content is required", 400);
  }

  const policyType = "terms";
  const contentText = sanitizeContent(contentHtml);

  let policy = await Policy.findOne({ policyType });

  if (policy) {
    policy.contentHtml = contentHtml;
    policy.contentText = contentText;
    policy.updatedAt = new Date();
    policy.updatedBy = req.user._id;
    await policy.save();
  } else {
    policy = await Policy.create({
      policyType,
      contentHtml,
      contentText,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return successResponse(res, "Terms & Conditions saved successfully", policy);
});

/**
 * @desc Update Terms & Conditions by ID (Admin only)
 * @route PUT /api/terms/:id
 * @access Admin
 */
export const updateTermsById = asyncHandler(async (req, res) => {
  const { contentHtml } = req.body;
  const { id } = req.params;

  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  if (!contentHtml) {
    return errorResponse(res, "Content is required", 400);
  }

  const policy = await Policy.findOne({ _id: id, policyType: "terms" });
  if (!policy) {
    return errorResponse(res, "Terms & Conditions not found", 404);
  }

  policy.contentHtml = contentHtml;
  policy.contentText = sanitizeContent(contentHtml);
  policy.updatedAt = new Date();
  policy.updatedBy = req.user._id;

  await policy.save();

  return successResponse(res, "Terms & Conditions updated successfully", policy);
});

/**
 * @desc Delete Terms & Conditions by ID (Admin only)
 * @route DELETE /api/terms/:id
 * @access Admin
 */
export const deleteTermsById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!req.user || !req.user.isAdmin) {
    return errorResponse(res, "Access denied: admin only", 403);
  }

  const policy = await Policy.findOne({ _id: id, policyType: "terms" });
  if (!policy) {
    return errorResponse(res, "Terms & Conditions not found", 404);
  }

  await policy.deleteOne();

  return successResponse(res, null, "Terms & Conditions deleted successfully");
});

/**
 * @desc Get Latest Terms & Conditions
 * @route GET /api/terms
 * @access Public
 */
export const getLatestTerms = asyncHandler(async (req, res) => {
  const terms = await Policy.findOne({ policyType: "terms" }).sort({ updatedAt: -1 });
  if (!terms) return errorResponse(res, "Terms & Conditions not found", 404);

  return successResponse(res, "Terms & Conditions fetched successfully", terms);
});

/**
 * @desc Get Terms & Conditions by ID
 * @route GET /api/terms/:id
 * @access Public
 */
export const getTermsById = asyncHandler(async (req, res) => {
  const terms = await Policy.findOne({ _id: req.params.id, policyType: "terms" });
  if (!terms) return errorResponse(res, "Terms & Conditions not found", 404);

  return successResponse(res, "Terms & Conditions fetched successfully", terms);
});
