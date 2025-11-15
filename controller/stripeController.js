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

    console.log(`📝 Subscription Lifecycle Logged: ${eventType} - ${stripeData?.id || 'Unknown ID'}`);
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
 * @desc Create Stripe subscription with immediate activation
 * @route POST /api/subscription/create
 * @access Private
 */
export const createSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const { planType: planTypeBody, paymentMethodId, priceId: customPriceId } = req.body;

    let planType = planTypeBody;
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

    // If no paymentMethodId provided -> return SetupIntent
    if (!paymentMethodId) {
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: ["card"],
      });
      return successResponse(res, "SetupIntent created. Attach a payment method first.", {
        clientSecret: setupIntent.client_secret,
        customerId: stripeCustomerId,
        requiresPaymentMethod: true
      });
    }

    // Attach the payment method to customer
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
    } catch (err) {
      console.error("❌ Error attaching payment method:", err);
      return errorResponse(res, "Failed to attach payment method: " + err.message, 400);
    }

    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // ✅ UPDATED: Determine price ID
    let priceId = customPriceId;

    if (!priceId && planType) {
      // Fetch available plans to find the correct price ID
      const products = await stripe.products.list({ active: true, limit: 10 });
      let targetProduct = null;

      for (const product of products.data) {
        const lowerName = product.name.toLowerCase();
        if (
          (planType === 'monthly' && lowerName.includes('monthly')) ||
          (planType === 'yearly' && lowerName.includes('yearly')) ||
          (planType === 'testing' && lowerName.includes('testing'))
        ) {
          targetProduct = product;
          break;
        }
      }

      if (!targetProduct) {
        return errorResponse(res, `No product found for plan type: ${planType}`, 404);
      }

      // Get the price for this product
      const prices = await stripe.prices.list({
        product: targetProduct.id,
        active: true,
        limit: 1
      });

      if (!prices.data.length) {
        return errorResponse(res, `No active price found for ${targetProduct.name}`, 404);
      }

      priceId = prices.data[0].id;
    }

    if (!priceId) {
      return errorResponse(res, "Could not determine price ID", 400);
    }

    // Verify the price exists and get details
    let priceDetails;
    try {
      priceDetails = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    } catch (error) {
      return errorResponse(res, "Invalid price ID", 400);
    }

    const { planType: detectedPlanType } = describePlan(priceDetails, priceDetails.product);

    // ✅ Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: priceId }],
      default_payment_method: paymentMethodId,
      expand: ["latest_invoice.payment_intent"],
    });

    // ✅ SINGLE COMPREHENSIVE LOG ENTRY
    // await logSubscriptionLifecycle(
    //   'SUBSCRIPTION_CREATED',
    //   subscription,
    //   user,
    //   {
    //     apiSource: 'createSubscription',
    //     planType: detectedPlanType,
    //     priceId,
    //     immediateActivation: (subscription.status === 'active' || subscription.status === 'trialing')
    //   }
    // );

    // Save subscription record
    const subscriptionRecord = await Subscription.findOneAndUpdate(
      { userId: user._id },
      {
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        priceId,
        amount: subscription.items.data[0].price.unit_amount / 100,
        currency: subscription.items.data[0].price.currency,
        planType: detectedPlanType,
        status: subscription.status,
        startDate: subscription.start_date ? new Date(subscription.start_date * 1000) : new Date(),
        endDate: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      },
      { upsert: true, new: true }
    );

    // ✅ Check if payment requires additional action
    const requiresAction = subscription.status === 'incomplete' &&
      subscription.latest_invoice?.payment_intent?.status === 'requires_action';

    // ✅ SUCCESS RESPONSE
    const successData = {
      subscription: {
        id: subscription.id,
        status: subscription.status,
        planType: detectedPlanType,
        amount: subscription.items.data[0].price.unit_amount / 100,
        currency: subscription.items.data[0].price.currency,
        startDate: subscription.start_date ? new Date(subscription.start_date * 1000).toISOString() : null,
        endDate: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
        currentPeriodStart: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
        currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      },
      payment: {
        requiresAction: requiresAction,
        clientSecret: subscription.latest_invoice?.payment_intent?.client_secret || null,
        status: subscription.latest_invoice?.payment_intent?.status || 'requires_payment_method',
      },
      user: {
        isSubscriptionActive: user.isSubscription,
        subscriptionType: user.subscriptionType,
        email: user.email,
      }
    };

    // ✅ Immediate activation if subscription is active or trialing
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      user.isSubscription = true;
      user.subscriptionType = detectedPlanType;
      user.subscriptionStartDate = subscription.start_date ? new Date(subscription.start_date * 1000) : new Date();
      user.subscriptionEndDate = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;

      await user.save();

      successData.user.isSubscriptionActive = true;
      successData.user.subscriptionType = detectedPlanType;

      console.log(`✅ USER ACTIVATED IMMEDIATELY: ${user.email}, isSubscription=${user.isSubscription}, planType=${detectedPlanType}`);
    } else {
      console.log(`⏳ Subscription created but payment pending. Status: ${subscription.status}`);
    }

    return successResponse(res,
      subscription.status === 'active' ?
        "Subscription created and activated successfully!" :
        requiresAction ?
          "Subscription created. Complete payment authentication to activate." :
          "Subscription created. Payment processing...",
      successData
    );
  } catch (error) {
    console.error("❌ createSubscription error:", error);

    // ✅ Log the error in lifecycle log
    await logSubscriptionLifecycle(
      'SUBSCRIPTION_CREATION_FAILED',
      { error: error.message },
      null,
      {
        apiSource: 'createSubscription',
        stack: error.stack
      }
    );

    return errorResponse(res, "Error creating subscription: " + error.message, 500);
  }
};

/**
 * @desc Stripe Webhook with Single Log System
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

  // ✅ Handle Stripe Events with Single Log System
  try {
    console.log(`🔔 Processing event: ${event.type}`);

    const eventData = event.data.object;
    let user = null;

    // Find user for customer events
    if (eventData.customer) {
      user = await User.findOne({ stripeCustomerId: eventData.customer });
    }

    switch (event.type) {
      case "customer.subscription.created": {
        const sub = eventData;

        // ✅ SINGLE LOG ENTRY
        // await logSubscriptionLifecycle(
        //   'SUBSCRIPTION_CREATED_WEBHOOK',
        //   sub,
        //   user,
        //   {
        //     webhookEvent: event.type,
        //     status: sub.status
        //   }
        // );

        if (user) {
          const price = sub.items?.data?.[0]?.price;
          const { planType } = describePlan(price);

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
            },
            { upsert: true }
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = eventData;

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
            endDate: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end || false,
          };

          if (sub.cancel_at_period_end) {
            updateData.status = "cancel_scheduled";
            updateData.canceledAt = new Date();
          }

          await Subscription.findOneAndUpdate(
            { userId: user._id },
            updateData,
            { upsert: false }
          );

          if (planType !== "unknown") {
            user.subscriptionType = planType;
          }
          user.subscriptionEndDate = new Date(sub.current_period_end * 1000);
          user.isSubscription = sub.status === "active" || sub.status === "trialing";

          await user.save();
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = eventData;

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
          await user.save();
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
                  latestInvoiceId: invoice.id,
                },
                { upsert: true }
              );

              // ✅ ACTIVATE USER SUBSCRIPTION
              user.isSubscription = true;
              user.subscriptionType = planType;
              user.subscriptionStartDate = new Date(stripeSub.current_period_start * 1000);
              user.subscriptionEndDate = new Date(stripeSub.current_period_end * 1000);

              await user.save();

              console.log(`✅ USER ACTIVATED via webhook: ${user.email}, isSubscription=${user.isSubscription}`);

              // ✅ Send notification
              await notifyUser(
                user,
                "Subscription activated",
                `Your subscription is now active. Enjoy premium features until ${toISODate(stripeSub.current_period_end)}.`,
                {
                  deeplink: "",
                  data: {
                    action: "subscription_activated",
                    subscriptionId: stripeSub.id,
                    currentPeriodEnd: toISODateTime(stripeSub.current_period_end),
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

      case "invoice.payment_failed": {
        const invoice = eventData;

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
          user.isSubscription = false;
          await user.save();
        }
        break;
      }

      case "payment_intent.succeeded": {
        const paymentIntent = eventData;

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'PAYMENT_INTENT_SUCCEEDED',
          paymentIntent,
          user,
          {
            webhookEvent: event.type,
            amount: paymentIntent.amount,
            invoiceId: paymentIntent.invoice
          }
        );
        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = eventData;

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'PAYMENT_INTENT_FAILED',
          paymentIntent,
          user,
          {
            webhookEvent: event.type,
            failureReason: paymentIntent.last_payment_error?.message
          }
        );
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