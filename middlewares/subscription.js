import { successResponse } from "../utils/response.js";

const subscriptionRequired = (req, res, next) => {
  // Allow admins to bypass subscription requirement
  if (!req.user || (!req.user.isSubscription && !req.user.isAdmin)) {
    return successResponse(
      res,
      "Your account does not have an active subscription. Please subscribe to access chat features.",
      null,
      null,
      200,
      0
    );
  }
  next();
};

export default subscriptionRequired;


