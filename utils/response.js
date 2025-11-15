// utils/response.js
/**
 * Success response with status indicator
 * @param {Object} res - Express response object
 * @param {string} message - Response message
 * @param {*} data - Response data (optional)
 * @param {Object} pagination - Pagination object (optional) - { currentPage, perPage, totalPage, totalData }
 * @param {number} statusCode - HTTP status code (default: 200)
 * @param {number} status - Status indicator: 1 = operation successful, 0 = operation failed but API worked (default: 1)
 */
export const successResponse = (res, message, data = null, pagination = null, statusCode = 200, status = 1) => {
  const response = {
    statusCode: statusCode,
    status: status, // 1 = success, 0 = operation failed but API worked
    message: message,
  };
  
  // Add data if provided
  if (data !== null) {
    response.data = data;
  }
  
  // Add pagination fields if provided (for GET APIs)
  if (pagination) {
    response.currentPage = pagination.currentPage || pagination.page || 1;
    response.perPage = pagination.itemsPerPage || pagination.limit || 10;
    response.totalPage = pagination.totalPages || Math.ceil((pagination.totalItems || 0) / (pagination.itemsPerPage || pagination.limit || 10));
    response.totalData = pagination.totalItems || 0;
  }
  
  return res.status(statusCode).json(response);
};

/**
 * Error response
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 * @param {number} code - HTTP status code
 *  200 = API worked but operation failed (use with status 0 in successResponse)
 *  404 = Not found (API/frontend issue / API logic issue)
 *  500 = Server error
 */
export const errorResponse = (res, message, code = 404) => {
  return res.status(code).json({
    statusCode: code,
    message: message,
  });
};
