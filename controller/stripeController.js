// controller/stripeController.js
import Stripe from "stripe";
import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { createStripeCustomer } from "../utils/stripeHelper.js";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../utils/errorHandler.js";
import { notifyUser } from "../utils/notificationHelper.js";
import { formatSubscriptionResponse } from "../utils/subscriptionResponseFormatter.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// File logging for webhook
const logPath = path.join(process.cwd(), "subscription_log.txt");
const logSubscriptionLifecycle = async (eventType, stripeData, user = null, additionalInfo = {}) => {
  try {
    // ✅ IMPROVED: Extract ID from different data structures
    let dataId = 'Unknown ID';
    
    if (stripeData) {
      if (stripeData.id) {
        dataId = stripeData.id;
      } else if (stripeData.sessionId) {
        dataId = stripeData.sessionId;
      } else if (stripeData.priceId) {
        dataId = stripeData.priceId;
      } else if (stripeData.subscriptionId) {
        dataId = stripeData.subscriptionId;
      } else if (stripeData.paymentIntentId) {
        dataId = stripeData.paymentIntentId;
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      user: user ? {
        id: user._id?.toString(),
        email: user.email,
        stripeCustomerId: user.stripeCustomerId
      } : null,
      stripeData: stripeData,
      additionalInfo,
      environment: process.env.NODE_ENV || 'development'
    };

    // ✅ SINGLE LINE JSON (no formatting)
    const singleLineJson = JSON.stringify(logEntry);

    // ✅ APPEND TO FILE WITH NEW LINE
    fs.appendFileSync(logPath, singleLineJson + '\n', { encoding: "utf8" });

    console.log(`📝 Subscription Lifecycle Logged: ${eventType} - ${dataId}`);
  } catch (e) {
    console.error("❌ Could not write lifecycle log:", e.message);
  }
};

export const describePlan = (price, product = null) => {
  const interval = price?.recurring?.interval || null;
  const nickname = price?.nickname || null;

  // Get product name if available
  const productName = product?.name || price?.product?.name || null;

  // Determine plan type based on product name and interval
  let planType = "unknown";
  let planLabel = "Subscription Plan";

  if (productName) {
    const lowerName = productName.toLowerCase();
    if (lowerName.includes("monthly")) {
      planType = "monthly";
      planLabel = "Monthly Plan";
    } else if (lowerName.includes("yearly")) {
      planType = "yearly";
      planLabel = "Yearly Plan";
    } else if (lowerName.includes("testing")) {
      planType = "testing";
      planLabel = "Testing Plan";
    } else {
      // Fallback to interval-based detection
      planType = interval === "year" ? "yearly" : interval === "month" ? "monthly" : "testing";
      planLabel = productName;
    }
  } else {
    // Fallback to interval-based detection
    planType = interval === "year" ? "yearly" : interval === "month" ? "monthly" : "testing";
    planLabel = interval === "year" ? "Yearly Plan" : interval === "month" ? "Monthly Plan" : "Testing Plan";
  }

  return { interval, nickname, planLabel, planType, productName };
};

const toISODateTime = (seconds) => {
  if (!seconds) return "";
  return new Date(seconds * 1000).toISOString();
};

const toISODate = (seconds) => {
  const iso = toISODateTime(seconds);
  return iso ? iso.slice(0, 10) : "";
};

export const selectPlan = async (req, res) => {
  try {
    const userId = req.user.id.toString();
    const { planType, priceId: customPriceId } = req.body;

    const user = await User.findById(userId);
    if (!user) return errorResponse(res, "User not found", 404);

    if (!planType && !customPriceId) {
      return errorResponse(res, "planType or priceId is required", 400);
    }

    if (user.isSubscription) {
      return errorResponse(res, "You already have an active subscription", 400);
    }

    // Ensure stripe customer exists
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await createStripeCustomer(user);
      user.stripeCustomerId = stripeCustomerId;
      await user.save();
    }

    // Determine price ID
    let priceId = customPriceId;

    if (!priceId && planType) {
      const products = await stripe.products.list({ active: true, limit: 10 });
      let targetProduct = null;

      for (const product of products.data) {
        const lowerName = product.name.toLowerCase();
        if (
          (planType === "monthly" && lowerName.includes("monthly")) ||
          (planType === "yearly" && lowerName.includes("yearly")) ||
          (planType === "testing" && lowerName.includes("testing"))
        ) {
          targetProduct = product;
          break;
        }
      }

      if (!targetProduct) {
        return errorResponse(res, `No product found for plan type: ${planType}`, 404);
      }

      const prices = await stripe.prices.list({
        product: targetProduct.id,
        active: true,
        limit: 1,
      });

      if (!prices.data.length) {
        return errorResponse(res, `No active price found for ${targetProduct.name}`, 404);
      }

      priceId = prices.data[0].id;
    }

    if (!priceId) {
      return errorResponse(res, "Could not determine price ID", 400);
    }

    // Validate price
    let priceDetails;
    try {
      priceDetails = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    } catch (error) {
      return errorResponse(res, "Invalid price ID", 400);
    }

    const { planType: detectedPlanType } = describePlan(priceDetails, priceDetails.product);

    // Create Subscription Record (IN_PROGRESS status)
    const subscriptionRecord = await Subscription.findOneAndUpdate(
      { userId: user._id },
      {
        stripeCustomerId,
        stripeSubscriptionId: `temp_${Date.now()}`,
        priceId,
        amount: priceDetails.unit_amount / 100,
        currency: priceDetails.currency,
        planType: detectedPlanType,
        status: "in_progress",
        startDate: new Date(),
      },
      { upsert: true, new: true }
    );

    // ✅ FIX: Create BOTH Payment Intent AND Checkout Session
    const paymentIntent = await stripe.paymentIntents.create({
      amount: priceDetails.unit_amount, // amount in cents
      currency: priceDetails.currency,
      customer: stripeCustomerId,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        userId: user._id.toString(),
        subscriptionRecordId: subscriptionRecord._id.toString(),
        priceId: priceId.toString(),
        planType: detectedPlanType.toString(),
      },
      description: `Subscription payment for ${detectedPlanType} plan`,
    });

    // Create Stripe Checkout Session
    const sessionData = {
      customer: stripeCustomerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
      client_reference_id: subscriptionRecord._id.toString(),

      metadata: {
        userId: user._id.toString(),
        planType: detectedPlanType.toString(),
        subscriptionRecordId: subscriptionRecord._id.toString(),
      },

      subscription_data: {
        metadata: {
          userId: user._id.toString(),
          planType: detectedPlanType.toString(),
          subscriptionRecordId: subscriptionRecord._id.toString(),
        },
      },
      
      payment_method_types: ['card'],
    };

    // Only enable automatic tax in production mode
    if (process.env.NODE_ENV === 'production') {
      sessionData.automatic_tax = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionData);

    await logSubscriptionLifecycle("PLAN_SELECTED", { 
      priceId, 
      planType: detectedPlanType,
      paymentIntentId: paymentIntent.id,
      sessionId: session.id 
    }, user, {
      apiSource: "selectPlan",
      checkoutSessionId: session.id,
      paymentIntentId: paymentIntent.id,
      subscriptionRecordId: subscriptionRecord._id.toString(),
    });

    // ✅ FIX: Return BOTH Payment Intent AND Checkout Session
    return successResponse(res, "Plan selected successfully. Use checkout URL to complete subscription.", {
      // Payment Intent details (for Flutter/React Native)
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      
      // Checkout Session details (for Web)
      checkoutUrl: session.url,
      sessionId: session.id,
      
      // Common details
      customerId: stripeCustomerId,
      requiresPayment: true,
      subscription: {
        id: subscriptionRecord._id,
        status: "in_progress",
        planType: detectedPlanType,
        amount: priceDetails.unit_amount / 100,
        currency: priceDetails.currency,
      },
    });
  } catch (error) {
    console.error("❌ selectPlan error:", error);

    await logSubscriptionLifecycle(
      "PLAN_SELECTION_FAILED",
      { error: error.message },
      null,
      {
        apiSource: "selectPlan",
        stack: error.stack,
      }
    );

    return errorResponse(res, "Error selecting plan: " + error.message, 500);
  }
};

/**
 * @desc Get available plan details - Direct Stripe API response
 * @route GET /api/subscription/plans
 * @access Public
 */
export const getPlans = async (req, res) => {
  try {
    // ✅ Direct Stripe API call - no modifications
    const products = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ['data.default_price']
    });

    // ✅ Return exact Stripe API response
    return successResponse(res, "Plans fetched successfully", products);
  } catch (error) {
    console.error("❌ getPlans error:", error);
    return errorResponse(res, "Error fetching plans: " + error.message, 500);
  }
};

/**
 * @desc Stripe Webhook with Complete Subscription Management
 * @route POST /api/subscription/webhook
 * @access Public
 */
export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  // 🚨 CRITICAL: Use raw body for webhook verification
  let rawBody = req.rawBody;
  if (!rawBody && req.body) {
    rawBody = JSON.stringify(req.body);
  }

  if (!rawBody) {
    console.error("❌ No raw body available for webhook verification");
    return res.status(400).send("Webhook Error: No raw body available");
  }

  // ✅ Verify signature
  try {
    if (process.env.STRIPE_WEBHOOK_UNSAFE_TESTING === "true" && process.env.NODE_ENV !== "production") {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      console.log("⚠️ Webhook signature verification skipped (test mode)");
    } else {
      if (!webhookSecret) {
        console.error("❌ Missing webhook secret");
        return res.status(500).send("Missing webhook secret");
      }
      if (!sig) {
        console.error("❌ No stripe-signature header provided");
        return res.status(400).send("Webhook Error: No stripe-signature header provided");
      }

      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      console.log("✅ Webhook signature verified successfully");
    }
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle Stripe Events with Complete Subscription Management
  try {
    console.log(`🔔 Processing event: ${event.type}`);

    const eventData = event.data.object;
    let user = null;

    // Find user for customer events
    if (eventData.customer) {
      user = await User.findOne({ stripeCustomerId: eventData.customer });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = eventData;
        console.log(`✅ Checkout session completed: ${session.id}`);
        
        if (session.mode === "subscription" && session.subscription) {
          // Retrieve the subscription to get full details
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          
          await logSubscriptionLifecycle(
            'CHECKOUT_COMPLETED',
            session,
            user,
            {
              webhookEvent: event.type,
              subscriptionId: subscription.id,
              status: subscription.status
            }
          );
          
          console.log(`🔄 Checkout completed for subscription: ${subscription.id}`);
        }
        break;
      }

      case "customer.subscription.created": {
        const sub = eventData;
        console.log(`🎉 New subscription created: ${sub.id}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'SUBSCRIPTION_CREATED',
          sub,
          user,
          {
            webhookEvent: event.type,
            status: sub.status
          }
        );

        if (user) {
          const price = sub.items?.data?.[0]?.price;
          const { planType } = describePlan(price);

          // ✅ UPDATE SUBSCRIPTION RECORD
          await Subscription.findOneAndUpdate(
            { userId: user._id },
            {
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
              priceId: price?.id,
              amount: price?.unit_amount ? price.unit_amount / 100 : undefined,
              currency: price?.currency,
              planType,
              status: sub.status,
              startDate: new Date(sub.current_period_start * 1000),
              endDate: new Date(sub.current_period_end * 1000),
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
            { upsert: true, new: true }
          );

          console.log(`✅ Subscription record updated for user: ${user.email}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = eventData;
        console.log(`📝 Subscription updated: ${sub.id}, Status: ${sub.status}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'SUBSCRIPTION_UPDATED',
          sub,
          user,
          {
            webhookEvent: event.type,
            status: sub.status,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            previousAttributes: event.data.previous_attributes || {}
          }
        );

        if (user) {
          const price = sub.items?.data?.[0]?.price;
          const { planType } = describePlan(price);

          const updateData = {
            status: sub.status,
            startDate: new Date(sub.current_period_start * 1000),
            endDate: new Date(sub.current_period_end * 1000),
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end || false,
          };

          if (sub.cancel_at_period_end) {
            updateData.status = "cancel_scheduled";
            updateData.canceledAt = new Date();
          }

          // ✅ UPDATE SUBSCRIPTION RECORD
          await Subscription.findOneAndUpdate(
            { userId: user._id },
            updateData,
            { upsert: false }
          );

          // ✅ UPDATE USER SUBSCRIPTION STATUS
          if (planType !== "unknown") {
            user.subscriptionType = planType;
          }

          user.subscriptionStartDate = new Date(sub.current_period_start * 1000);
          user.subscriptionEndDate = new Date(sub.current_period_end * 1000);
          user.isSubscription = sub.status === "active" || sub.status === "trialing";

          await user.save();
          
          console.log(`✅ User subscription updated: ${user.email}, Status: ${user.isSubscription}, Type: ${user.subscriptionType}`);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = eventData;
        const subscriptionId = invoice.subscription;

        if (subscriptionId && invoice.paid === true) {
          try {
            const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);

            // ✅ SINGLE LOG ENTRY
            await logSubscriptionLifecycle(
              'PAYMENT_SUCCEEDED',
              stripeSub,
              user,
              {
                webhookEvent: event.type,
                invoiceId: invoice.id,
                amountPaid: invoice.amount_paid,
                billingReason: invoice.billing_reason
              }
            );

            if (user) {
              const price = stripeSub.items?.data?.[0]?.price;
              const { planType } = describePlan(price);

              // ✅ UPDATE SUBSCRIPTION RECORD
              await Subscription.findOneAndUpdate(
                { userId: user._id },
                {
                  stripeCustomerId: stripeSub.customer,
                  stripeSubscriptionId: stripeSub.id,
                  priceId: price?.id,
                  amount: price?.unit_amount ? price.unit_amount / 100 : undefined,
                  currency: price?.currency,
                  planType,
                  status: "active",
                  startDate: new Date(stripeSub.current_period_start * 1000),
                  endDate: new Date(stripeSub.current_period_end * 1000),
                  currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
                  currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
                  latestInvoiceId: invoice.id,
                },
                { upsert: true }
              );

              // ✅ ACTIVATE USER SUBSCRIPTION
              user.isSubscription = true;
              user.subscriptionType = planType;
              user.subscriptionStartDate = new Date(stripeSub.current_period_start * 1000);
              user.subscriptionEndDate = new Date(stripeSub.current_period_end * 1000);
              user.subscriptionActivatedAt = new Date();

              await user.save();

              console.log(`✅ USER ACTIVATED via webhook: ${user.email}, isSubscription=${user.isSubscription}, type=${user.subscriptionType}`);

              // ✅ Send notification
              await notifyUser(
                user,
                "Subscription activated",
                `Your ${planType} subscription is now active. Enjoy premium features until ${toISODate(stripeSub.current_period_end)}.`,
                {
                  deeplink: "",
                  data: {
                    action: "subscription_activated",
                    subscriptionId: stripeSub.id,
                    currentPeriodEnd: toISODateTime(stripeSub.current_period_end),
                    planType: planType
                  },
                }
              );
            }
          } catch (error) {
            console.error("❌ ERROR in invoice.payment_succeeded:", error);
            // ✅ Log the error
            await logSubscriptionLifecycle(
              'WEBHOOK_PROCESSING_ERROR',
              { error: error.message, subscriptionId },
              user,
              {
                webhookEvent: event.type,
                stack: error.stack
              }
            );
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = eventData;
        console.log(`🗑️ Subscription deleted: ${sub.id}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'SUBSCRIPTION_DELETED',
          sub,
          user,
          {
            webhookEvent: event.type,
            status: 'canceled'
          }
        );

        if (user) {
          await Subscription.findOneAndUpdate(
            { userId: user._id },
            {
              status: "canceled",
              canceledAt: new Date(),
              endDate: new Date(sub.current_period_end * 1000),
            }
          );

          user.isSubscription = false;
          user.subscriptionType = null;
          user.subscriptionEndDate = null;
          await user.save();
          
          console.log(`✅ User subscription canceled: ${user.email}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = eventData;
        console.log(`❌ Payment failed for invoice: ${invoice.id}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'PAYMENT_FAILED',
          invoice,
          user,
          {
            webhookEvent: event.type,
            attemptCount: invoice.attempt_count,
            nextPaymentAttempt: invoice.next_payment_attempt
          }
        );

        if (user) {
          // Optionally set user to not subscribed if payment fails
          // user.isSubscription = false;
          // await user.save();
          
          console.log(`⚠️ Payment failed for user: ${user.email}`);
        }
        break;
      }

      default:
        console.log(`⚡ Unhandled event type: ${event.type}`);
        break;
    }

    return res.json({ received: true, processed: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).send("Webhook handler error");
  }
};

/**
 * @desc Cancel active subscription
 * @route DELETE /api/subscription/cancel
 * @access Private (User)
 */
export const cancelSubscription = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user?.stripeCustomerId) {
      return errorResponse(res, "Stripe customer not found", 404);
    }

    // Find active Stripe subscription
    const activeSub = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: "active",
      limit: 1,
    });

    if (!activeSub.data.length) {
      return errorResponse(res, "No active subscription found", 404);
    }

    const sub = activeSub.data[0];

    if (sub.cancel_at_period_end) {
      return successResponse(res, "Subscription already scheduled for cancellation", {
        subscriptionId: sub.id,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        status: sub.status,
      });
    }

    // Schedule cancel at period end
    const canceled = await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    });

    // ✅ SINGLE LOG ENTRY
    await logSubscriptionLifecycle(
      'SUBSCRIPTION_CANCEL_REQUESTED',
      canceled,
      user,
      {
        apiSource: 'cancelSubscription',
        cancelAtPeriodEnd: canceled.cancel_at_period_end,
        currentPeriodEnd: new Date(canceled.current_period_end * 1000)
      }
    );

    return successResponse(res, "Subscription cancellation requested successfully", {
      subscriptionId: canceled.id,
      cancelAtPeriodEnd: canceled.cancel_at_period_end,
      currentPeriodEnd: new Date(canceled.current_period_end * 1000),
      status: canceled.status,
    });
  } catch (error) {
    console.error("❌ cancelSubscription error:", error);
    return errorResponse(res, "Error canceling subscription: " + error.message, 500);
  }
});

/**
 * @desc Get all subscriptions with Stripe details (admin only) - OPTIMIZED
 * @route GET /api/subscription/admin/list
 */
export const getAllSubscriptionsAdmin = async (req, res) => {
  if (!req.user?.isAdmin) {
    return errorResponse(res, "Admin access required", 403);
  }

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const search = req.query.search ? req.query.search.trim() : "";
    const status = req.query.status || "";
    const planType = req.query.planType || "";
    const orderBy = req.query.orderBy || "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;
    const skip = (page - 1) * limit;

    console.log(`📊 Admin subscriptions request: page=${page}, limit=${limit}, search="${search}", status="${status}", planType="${planType}"`);

    // Build optimized query pipeline
    const pipeline = [
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      {
        $unwind: {
          path: "$user",
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    // ✅ OPTIMIZED: Add search filters
    const matchConditions = [];

    if (search) {
      const regex = new RegExp(search, "i");
      matchConditions.push({
        $or: [
          { stripeSubscriptionId: regex },
          { stripeCustomerId: regex },
          { planType: regex },
          { status: regex },
          { "user.firstname": regex },
          { "user.lastname": regex },
          { "user.email": regex },
          { "user.phoneNumber": regex },
        ],
      });
    }

    // ✅ OPTIMIZED: Add status filter
    if (status) {
      matchConditions.push({ status: new RegExp(status, "i") });
    }

    // ✅ OPTIMIZED: Add planType filter
    if (planType) {
      matchConditions.push({ planType: new RegExp(planType, "i") });
    }

    if (matchConditions.length > 0) {
      pipeline.push({
        $match: matchConditions.length === 1 ? matchConditions[0] : { $and: matchConditions }
      });
    }

    // ✅ OPTIMIZED: Get total count first (for pagination)
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await Subscription.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // ✅ OPTIMIZED: Get paginated data
    pipeline.push(
      { $sort: { [orderBy]: order } },
      { $skip: skip },
      { $limit: limit }
    );

    const subscriptions = await Subscription.aggregate(pipeline);

    // ✅ OPTIMIZED: Batch process Stripe data for better performance
    const optimizedSubscriptions = await Promise.all(
      subscriptions.map(async (sub) => {
        const user = sub.user || null;

        // ✅ OPTIMIZED: Only fetch Stripe data if subscription ID exists
        if (!sub.stripeSubscriptionId) {
          return formatSubscriptionResponse(sub, user, null, null, null, null);
        }

        try {
          // ✅ OPTIMIZED: Fetch subscription with minimal expands for list view
          const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, {
            expand: ["latest_invoice", "default_payment_method"]
          });

          return formatSubscriptionResponse(
            sub,
            user,
            stripeSub,
            stripeSub.latest_invoice,
            stripeSub.default_payment_method,
            null // Skip price expansion for list view
          );
        } catch (err) {
          console.warn(`⚠️ Stripe fetch failed for ${sub.stripeSubscriptionId}: ${err.message}`);
          // Return basic data if Stripe fetch fails
          return formatSubscriptionResponse(sub, user, null, null, null, null);
        }
      })
    );

    console.log(`✅ Admin subscriptions fetched: ${optimizedSubscriptions.length} of ${total}`);

    return successResponse(
      res,
      "All subscriptions fetched",
      {
        subscriptions: optimizedSubscriptions,
        pagination: {
          currentPage: page,
          perPage: limit,
          totalPages: Math.ceil(total / limit),
          totalData: total,
          hasMore: page * limit < total
        }
      }
    );
  } catch (error) {
    console.error("❌ getAllSubscriptionsAdmin error:", error);
    return errorResponse(res, "Error fetching subscriptions: " + error.message, 500);
  }
};

/**
 * @desc Get subscription by ID with all details (Admin)
 * @route GET /api/subscription/admin/:subscriptionId
 * @access Private (Admin)
 */
export const getSubscriptionById = asyncHandler(async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    if (!req.user?.isAdmin) {
      return errorResponse(res, "Admin access required", 403);
    }

    // Find in database for additional context
    const dbSubscription = await Subscription.findOne({
      stripeSubscriptionId: subscriptionId
    }).populate('userId');

    // Fetch from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: [
        "latest_invoice",
        "latest_invoice.payment_intent",
        "default_payment_method",
        "items.data.price"
      ]
    });

    // Find user
    const user = dbSubscription?.userId
      ? await User.findById(dbSubscription.userId)
      : await User.findOne({ stripeCustomerId: stripeSubscription.customer });

    // Extract data
    const latestInvoice = stripeSubscription.latest_invoice;
    const paymentMethod = stripeSubscription.default_payment_method;
    const price = stripeSubscription.items.data[0]?.price;

    // Format response
    const subscription = formatSubscriptionResponse(
      dbSubscription || { stripeSubscriptionId: subscriptionId },
      user,
      stripeSubscription,
      latestInvoice,
      paymentMethod,
      price
    );

    return successResponse(res, "Subscription details fetched successfully", {
      subscription: subscription
    });

  } catch (error) {

    if (error.type === 'StripeInvalidRequestError' && error.code === 'resource_missing') {
      return errorResponse(res, "Subscription not found", 404);
    }

    return errorResponse(res, "Error fetching subscription: " + error.message, 500);
  }
});

/**
 * @desc Get user's subscriptions from Stripe (current or all) - Fixed version
 * @route GET /api/subscription/list?type=current|all
 * @access Private (User)
 */
export const getUserSubscriptions = asyncHandler(async (req, res) => {
  const { type } = req.query;
  const user = await User.findById(req.user.id);

  if (!user?.stripeCustomerId) {
    return res.status(404).json({
      success: false,
      message: "Stripe customer not found",
    });
  }

  try {
    // ✅ FIXED: Reduced expansion levels to avoid the 4-level limit
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      expand: [
        "data.items.data.price", // Only expand to price level (3 levels)
        "data.latest_invoice",
        "data.default_payment_method"
      ],
      limit: 12,
      status: type === 'current' ? 'active' : 'all'
    });

    if (!subscriptions.data.length) {
      return res.status(404).json({
        success: false,
        message: "No subscriptions found for this user",
      });
    }

    // ✅ Fetch product details separately for each subscription
    const formattedSubscriptions = await Promise.all(
      subscriptions.data.map(async (sub) => {
        let productDetails = {};

        // Get product details separately to avoid expansion limit
        const price = sub.items.data[0]?.price;
        if (price?.product && typeof price.product === 'string') {
          try {
            const product = await stripe.products.retrieve(price.product);
            productDetails = {
              id: product.id,
              name: product.name,
              description: product.description,
              images: product.images,
            };
          } catch (error) {
            console.warn(`⚠️ Failed to fetch product ${price.product}:`, error.message);
          }
        }

        return {
          id: sub.id,
          object: sub.object,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
          canceled_at: sub.canceled_at,
          created: sub.created,
          start_date: sub.start_date,
          items: {
            data: sub.items.data.map(item => ({
              id: item.id,
              price: {
                id: item.price.id,
                product: productDetails.id ? productDetails : item.price.product,
                unit_amount: item.price.unit_amount,
                currency: item.price.currency,
                recurring: item.price.recurring,
              }
            }))
          },
          latest_invoice: sub.latest_invoice ? {
            id: sub.latest_invoice.id,
            status: sub.latest_invoice.status,
            amount_paid: sub.latest_invoice.amount_paid,
            amount_due: sub.latest_invoice.amount_due,
            hosted_invoice_url: sub.latest_invoice.hosted_invoice_url,
            invoice_pdf: sub.latest_invoice.invoice_pdf,
          } : null,
          default_payment_method: sub.default_payment_method ? {
            id: sub.default_payment_method.id,
            type: sub.default_payment_method.type,
            card: sub.default_payment_method.card ? {
              brand: sub.default_payment_method.card.brand,
              last4: sub.default_payment_method.card.last4,
            } : null,
          } : null,
        };
      })
    );

    return successResponse(res,
      type === "current"
        ? "Current subscription fetched successfully"
        : "All subscriptions fetched successfully",
      {
        object: "list",
        data: formattedSubscriptions,
        has_more: subscriptions.has_more,
        url: `/v1/subscriptions?customer=${user.stripeCustomerId}`
      }
    );

  } catch (error) {
    console.error("❌ getUserSubscriptions error:", error);
    return errorResponse(res, "Failed to fetch subscriptions: " + error.message, 500);
  }
});

/**
 * @desc Verify payment and activate subscription
 * @route POST /api/subscription/verify-payment
 * @access Private
 */
export const getPaymentMethodFromIntent = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const userId = req.user.id;

    console.log(`🔍 [PAYMENT_VERIFY] Starting payment verification for user: ${userId}, paymentIntent: ${paymentIntentId}`);

    if (!paymentIntentId) {
      console.log(`❌ [PAYMENT_VERIFY] Missing paymentIntentId for user: ${userId}`);
      return errorResponse(res, "Payment Intent ID is required", 400);
    }

    // Retrieve payment intent
    console.log(`🔍 [PAYMENT_VERIFY] Retrieving payment intent: ${paymentIntentId}`);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['payment_method', 'invoice.subscription']
    });

    console.log(`🔍 [PAYMENT_VERIFY] Payment Intent Status: ${paymentIntent.status}`);
    console.log(`🔍 [PAYMENT_VERIFY] Payment Intent Amount: ${paymentIntent.amount}`);
    console.log(`🔍 [PAYMENT_VERIFY] Payment Intent Invoice: ${paymentIntent.invoice}`);

    // Check if payment was successful
    if (paymentIntent.status !== 'succeeded') {
      console.log(`❌ [PAYMENT_VERIFY] Payment not succeeded: ${paymentIntent.status}`);
      return errorResponse(res, `Payment status: ${paymentIntent.status}. Please complete the payment first.`, 400);
    }

    if (!paymentIntent.payment_method) {
      console.log(`❌ [PAYMENT_VERIFY] No payment method found for payment intent: ${paymentIntentId}`);
      return errorResponse(res, "No payment method found for this payment", 404);
    }

    // Get user
    console.log(`🔍 [PAYMENT_VERIFY] Finding user: ${userId}`);
    const user = await User.findById(userId);
    if (!user) {
      console.log(`❌ [PAYMENT_VERIFY] User not found: ${userId}`);
      return errorResponse(res, "User not found", 404);
    }

    console.log(`🔍 [PAYMENT_VERIFY] User found: ${user.email}, Stripe Customer: ${user.stripeCustomerId}`);
    console.log(`🔍 [PAYMENT_VERIFY] Current user subscription status: isSubscription=${user.isSubscription}, subscriptionType=${user.subscriptionType}`);

    const paymentMethod = paymentIntent.payment_method;
    console.log(`🔍 [PAYMENT_VERIFY] Payment Method Type: ${paymentMethod.type}, ID: ${paymentMethod.id}`);

    // Get subscription details
    let stripeSubscription = null;
    let invoice = null;

    if (paymentIntent.invoice) {
      console.log(`🔍 [PAYMENT_VERIFY] Payment intent has invoice: ${paymentIntent.invoice}`);
      invoice = paymentIntent.invoice;

      if (invoice.subscription) {
        stripeSubscription = invoice.subscription;
        console.log(`🔍 [PAYMENT_VERIFY] Found subscription from invoice: ${stripeSubscription.id}`);
      } else {
        console.log(`🔍 [PAYMENT_VERIFY] Invoice exists but no subscription attached`);
      }
    } else {
      console.log(`🔍 [PAYMENT_VERIFY] No invoice found in payment intent`);
    }

    // If no subscription found, search for active ones
    if (!stripeSubscription && user.stripeCustomerId) {
      console.log(`🔍 [PAYMENT_VERIFY] Searching for subscriptions for customer: ${user.stripeCustomerId}`);
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'active',
        limit: 1
      });

      console.log(`🔍 [PAYMENT_VERIFY] Found ${subscriptions.data.length} subscriptions for customer`);

      if (subscriptions.data.length > 0) {
        stripeSubscription = subscriptions.data[0];
        console.log(`🔍 [PAYMENT_VERIFY] Using subscription from list: ${stripeSubscription.id}, status: ${stripeSubscription.status}`);
      }
    }

    // ✅ Get the plan type from existing subscription record first
    console.log(`🔍 [PAYMENT_VERIFY] Looking for existing subscription record for user`);
    let subscriptionRecord = await Subscription.findOne({ userId: user._id });
    let detectedPlanType = "monthly"; // default

    if (subscriptionRecord) {
      console.log(`🔍 [PAYMENT_VERIFY] Found existing subscription record: ${subscriptionRecord._id}`);
      console.log(`🔍 [PAYMENT_VERIFY] Previous plan type: ${subscriptionRecord.planType}`);
      console.log(`🔍 [PAYMENT_VERIFY] Previous status: ${subscriptionRecord.status}`);
      
      // ✅ Use the plan type from subscription record
      detectedPlanType = subscriptionRecord.planType || "monthly";
    } else {
      console.log(`🔍 [PAYMENT_VERIFY] No existing subscription record found`);
    }

    // ✅ Also check payment intent metadata for plan type
    if (paymentIntent.metadata?.planType) {
      detectedPlanType = paymentIntent.metadata.planType;
      console.log(`🔍 [PAYMENT_VERIFY] Using plan type from payment intent metadata: ${detectedPlanType}`);
    }

    // ✅ Calculate end date based on actual plan type
    const now = new Date();
    let defaultEndDate = new Date();

    if (detectedPlanType === "yearly") {
      defaultEndDate.setFullYear(defaultEndDate.getFullYear() + 1);
      console.log(`🔍 [PAYMENT_VERIFY] Yearly plan - setting end date to 1 year from now: ${defaultEndDate}`);
    } else if (detectedPlanType === "monthly") {
      defaultEndDate.setMonth(defaultEndDate.getMonth() + 1);
      console.log(`🔍 [PAYMENT_VERIFY] Monthly plan - setting end date to 1 month from now: ${defaultEndDate}`);
    } else {
      defaultEndDate.setMonth(defaultEndDate.getMonth() + 1);
      console.log(`🔍 [PAYMENT_VERIFY] Unknown plan type (${detectedPlanType}) - defaulting to 1 month: ${defaultEndDate}`);
    }

    if (!stripeSubscription) {
      console.log(`⚠️ [PAYMENT_VERIFY] No Stripe subscription found for user ${user.email}`);
      console.log(`🔍 [PAYMENT_VERIFY] Using calculated end date for ${detectedPlanType} plan: ${defaultEndDate}`);
    } else {
      console.log(`✅ [PAYMENT_VERIFY] Stripe subscription found: ${stripeSubscription.id}`);
      console.log(`🔍 [PAYMENT_VERIFY] Subscription status: ${stripeSubscription.status}`);
      console.log(`🔍 [PAYMENT_VERIFY] Current period: ${new Date(stripeSubscription.current_period_start * 1000)} to ${new Date(stripeSubscription.current_period_end * 1000)}`);
      
      // Update detected plan type from Stripe subscription
      const stripePlanType = describePlan(stripeSubscription.items.data[0]?.price).planType;
      if (stripePlanType !== "unknown") {
        detectedPlanType = stripePlanType;
        console.log(`🔍 [PAYMENT_VERIFY] Updated plan type from Stripe: ${detectedPlanType}`);
      }
    }

    // ✅ CRITICAL - Always set the subscriptionType on user
    console.log(`🔍 [PAYMENT_VERIFY] Setting user subscription to active with type: ${detectedPlanType}`);

    user.isSubscription = true;
    user.subscriptionActivatedAt = now;
    user.subscriptionType = detectedPlanType; // ✅ This was missing!

    if (stripeSubscription) {
      user.subscriptionStartDate = new Date(stripeSubscription.current_period_start * 1000);
      user.subscriptionEndDate = new Date(stripeSubscription.current_period_end * 1000);
      console.log(`🔍 [PAYMENT_VERIFY] User dates from Stripe - Start: ${user.subscriptionStartDate}, End: ${user.subscriptionEndDate}, Type: ${detectedPlanType}`);
    } else {
      // ✅ Set both dates when no Stripe subscription found - use calculated dates based on plan type
      user.subscriptionStartDate = now;
      user.subscriptionEndDate = defaultEndDate;
      console.log(`🔍 [PAYMENT_VERIFY] User dates set manually - Start: ${user.subscriptionStartDate}, End: ${user.subscriptionEndDate}, Type: ${detectedPlanType}`);
    }

    console.log(`🔍 [PAYMENT_VERIFY] Saving user to database...`);
    console.log(`🔍 [PAYMENT_VERIFY] User subscription data before save:`, {
      isSubscription: user.isSubscription,
      subscriptionType: user.subscriptionType,
      subscriptionStartDate: user.subscriptionStartDate,
      subscriptionEndDate: user.subscriptionEndDate
    });
    
    await user.save();
    console.log(`✅ [PAYMENT_VERIFY] User saved successfully`);

    // Update subscription record
    if (subscriptionRecord) {
      console.log(`🔍 [PAYMENT_VERIFY] Updating existing subscription record: ${subscriptionRecord._id}`);
      console.log(`🔍 [PAYMENT_VERIFY] Previous status: ${subscriptionRecord.status}`);

      subscriptionRecord.status = "active";
      subscriptionRecord.stripeSubscriptionId = stripeSubscription?.id || `sub_${Date.now()}`;
      subscriptionRecord.stripePaymentIntentId = paymentIntentId;
      subscriptionRecord.paymentMethodId = paymentMethod.id;
      subscriptionRecord.activatedAt = now;
      subscriptionRecord.startDate = user.subscriptionStartDate;
      subscriptionRecord.endDate = user.subscriptionEndDate;
      subscriptionRecord.planType = detectedPlanType; // ✅ Ensure plan type is set

      if (stripeSubscription) {
        subscriptionRecord.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
        subscriptionRecord.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
      } else {
        // ✅ Set default period dates when no Stripe subscription
        subscriptionRecord.currentPeriodStart = now;
        subscriptionRecord.currentPeriodEnd = defaultEndDate;
      }

      console.log(`🔍 [PAYMENT_VERIFY] Subscription record dates - Start: ${subscriptionRecord.startDate}, End: ${subscriptionRecord.endDate}, Type: ${subscriptionRecord.planType}`);
    } else {
      console.log(`🔍 [PAYMENT_VERIFY] No existing subscription record found, creating new one`);

      const price = stripeSubscription?.items.data[0]?.price;

      // ✅ Ensure all required fields have values with correct plan type
      subscriptionRecord = new Subscription({
        userId: user._id,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: stripeSubscription?.id || `sub_${Date.now()}`,
        stripePaymentIntentId: paymentIntentId,
        paymentMethodId: paymentMethod.id,
        priceId: price?.id,
        amount: price?.unit_amount ? price.unit_amount / 100 : paymentIntent.amount / 100,
        currency: price?.currency || paymentIntent.currency,
        planType: detectedPlanType, // ✅ Use the detected plan type
        status: "active",
        startDate: user.subscriptionStartDate,
        endDate: user.subscriptionEndDate,
        currentPeriodStart: stripeSubscription ? new Date(stripeSubscription.current_period_start * 1000) : user.subscriptionStartDate,
        currentPeriodEnd: stripeSubscription ? new Date(stripeSubscription.current_period_end * 1000) : user.subscriptionEndDate,
        activatedAt: now,
      });
    }

    console.log(`🔍 [PAYMENT_VERIFY] Saving subscription record...`);
    await subscriptionRecord.save();
    console.log(`✅ [PAYMENT_VERIFY] Subscription record saved: ${subscriptionRecord._id}`);
    console.log(`🔍 [PAYMENT_VERIFY] Subscription record details:`, {
      id: subscriptionRecord._id,
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      status: subscriptionRecord.status,
      planType: subscriptionRecord.planType,
      startDate: subscriptionRecord.startDate,
      endDate: subscriptionRecord.endDate
    });

    // ✅ Double-check that user has subscriptionType set
    const updatedUser = await User.findById(userId);
    console.log(`🔍 [PAYMENT_VERIFY] Final user verification - subscriptionType: ${updatedUser.subscriptionType}`);

    // Log and notify
    console.log(`🔍 [PAYMENT_VERIFY] Creating lifecycle log...`);
    await logSubscriptionLifecycle(
      'PAYMENT_VERIFIED_AND_ACTIVATED',
      {
        paymentIntentId,
        subscriptionId: stripeSubscription?.id,
        userStartDate: user.subscriptionStartDate,
        userEndDate: user.subscriptionEndDate,
        planType: detectedPlanType
      },
      user,
      {
        apiSource: 'verify-payment',
        paymentMethodId: paymentMethod.id
      }
    );

    console.log(`🔍 [PAYMENT_VERIFY] Sending notification to user...`);
    await notifyUser(
      user,
      "Payment Verified & Subscription Activated 🎉",
      `Your ${detectedPlanType} subscription is now active until ${user.subscriptionEndDate.toLocaleDateString()}. Thank you for your payment!`,
      {
        deeplink: "/subscription",
        data: {
          action: "subscription_activated",
          paymentIntentId: paymentIntentId,
          startDate: user.subscriptionStartDate,
          endDate: user.subscriptionEndDate,
          planType: detectedPlanType
        },
      }
    );

    console.log(`✅ [PAYMENT_VERIFY] SUCCESS - Payment verified and subscription activated for user: ${user.email}`);
    console.log(`🔍 [PAYMENT_VERIFY] Final user status: isSubscription=${user.isSubscription}, type=${user.subscriptionType}`);
    console.log(`🔍 [PAYMENT_VERIFY] Final subscription record: ${subscriptionRecord._id}, status=${subscriptionRecord.status}, type=${subscriptionRecord.planType}`);

    return successResponse(res, "Payment verified and subscription activated successfully!", {
      payment: {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      },
      subscription: {
        id: subscriptionRecord._id,
        status: "active",
        planType: subscriptionRecord.planType,
        startDate: subscriptionRecord.startDate,
        endDate: subscriptionRecord.endDate,
      },
      user: {
        isSubscription: user.isSubscription,
        subscriptionType: user.subscriptionType,
        subscriptionStartDate: user.subscriptionStartDate,
        subscriptionEndDate: user.subscriptionEndDate
      },
      message: `Your ${detectedPlanType} subscription is now active!`
    });

  } catch (error) {
    console.error("❌ [PAYMENT_VERIFY] verifyPaymentSuccess error:", error);
    console.error("❌ [PAYMENT_VERIFY] Error details:", error.stack);

    await logSubscriptionLifecycle(
      'PAYMENT_VERIFICATION_FAILED',
      { error: error.message },
      null,
      {
        apiSource: 'verify-payment',
        stack: error.stack
      }
    );

    if (error.code === 'resource_missing') {
      console.log(`❌ [PAYMENT_VERIFY] Resource missing error - Payment Intent may not exist`);
      return errorResponse(res, "Payment Intent does not exist. Please check and try again.", 404);
    }

    return errorResponse(res, "Payment verification failed: " + error.message, 500);
  }
};