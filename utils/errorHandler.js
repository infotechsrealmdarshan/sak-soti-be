import { errorResponse, successResponse } from "./response.js";

/**
 * Async handler wrapper for async route handlers
 * Automatically catches errors and passes them to Express error handler
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global server error handler (500)
 * Use this for centralized 500 error management across projects
 * 
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware
 */
export const globalErrorHandler = (err, req, res, next) => {
  console.error("❌ Server Error:", err);

  // Log full error details in development
  if (process.env.NODE_ENV === 'development') {
    console.error("Error Stack:", err.stack);
  }

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return errorResponse(res, err.message || "Validation error", 400);
  }

  if (err.name === 'CastError') {
    // CastError means invalid ID format - return 200 with status 0 (API worked, but ID not found)
    // Determine resource type from error path if possible
    const errorPath = err.path || '';
    let resourceName = 'Resource';
    if (errorPath.includes('user') || errorPath.includes('User')) resourceName = 'User';
    else if (errorPath.includes('post') || errorPath.includes('Post')) resourceName = 'Post';
    else if (errorPath.includes('news') || errorPath.includes('News')) resourceName = 'News';
    else if (errorPath.includes('chat') || errorPath.includes('Chat')) resourceName = 'Chat';
    else if (errorPath.includes('group') || errorPath.includes('Group')) resourceName = 'Group';
    
    return successResponse(res, `${resourceName} id not found`, null, null, 200, 0);
  }

  if (err.name === 'JsonWebTokenError') {
    return errorResponse(res, "Invalid token", 401);
  }

  if (err.name === 'TokenExpiredError') {
    return errorResponse(res, "Token expired", 401);
  }

  // Default 500 server error
  const errorMessage = process.env.NODE_ENV === 'production' 
    ? "Internal Server Error" 
    : (err.message || "Internal Server Error");

  return errorResponse(res, errorMessage, 500);
};

/**
 * Server error response helper
 * Use this function directly in controllers for 500 errors
 * 
 * @param {Object} res - Express response object
 * @param {string} message - Custom error message (optional)
 */
export const serverError = (res, message = "Internal Server Error") => {
  return errorResponse(res, message, 500);
};
