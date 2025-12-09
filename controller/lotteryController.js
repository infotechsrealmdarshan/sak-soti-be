import axios from "axios";
import LotteryState from "../models/LotteryState.js";
import LotteryResult from "../models/LotteryResult.js";
import LotteryFrequency from "../models/LotteryFrequency.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse, errorResponse } from "../utils/response.js";

const COUNTRY_CODE = "us";

const lotteryApiClient = () => {
  const baseURL =
    process.env.LOTTERY_API_BASE_URL?.trim() ||
    "https://www.lotteryresultsfeed.com/api/";
  const token = process.env.LOTTERY_API_TOKEN;

  if (!token) {
    throw new Error("LOTTERY_API_TOKEN is missing in environment");
  }

  return axios.create({
    baseURL,
    timeout: 10000,
    headers: {
      Accept: "application/json",
      Authorization: token,
    },
  });
};

const fetchLotteryStates = async () => {
  const client = lotteryApiClient();

  const [statesRes, statesDetailsRes] = await Promise.all([
    client.get("/lottery/states", { params: { country: COUNTRY_CODE } }),
    client.get("/lottery/states-details", { params: { country: COUNTRY_CODE } }),
  ]);

  const statesMap = statesRes?.data?.states || {};
  const statesDetails = statesDetailsRes?.data?.states || [];

  return { statesMap, statesDetails };
};

const mergeStateData = (statesMap, statesDetails) => {
  const detailByCode = new Map(
    statesDetails.map((state) => [state.code?.toLowerCase(), state])
  );

  return Object.entries(statesMap).map(([code, name]) => {
    const normalizedCode = code.toLowerCase();
    const detail = detailByCode.get(normalizedCode);

    return {
      country: COUNTRY_CODE.toUpperCase(),
      code: normalizedCode,
      name,
      lotteryCount: detail?.lottery_count ?? null,
      info: detail?.info ?? null,
    };
  });
};

const computeDiff = (incoming, existingMap) => {
  const insertOps = [];
  const updateOps = [];
  let skipped = 0;

  incoming.forEach((state) => {
    const current = existingMap.get(state.code);

    if (!current) {
      insertOps.push({ document: state });
      return;
    }

    const hasChanges =
      current.name !== state.name ||
      (current.lotteryCount ?? null) !== (state.lotteryCount ?? null) ||
      JSON.stringify(current.info ?? null) !== JSON.stringify(state.info ?? null);

    if (hasChanges) {
      updateOps.push({
        filter: { _id: current._id },
        update: {
          $set: {
            name: state.name,
            lotteryCount: state.lotteryCount ?? null,
            info: state.info ?? null,
            country: state.country,
          },
        },
      });
    } else {
      skipped += 1;
    }
  });

  return { insertOps, updateOps, skipped };
};

export const syncLotteryStates = asyncHandler(async (req, res) => {
  try {
    const { statesMap, statesDetails } = await fetchLotteryStates();
    const incomingStates = mergeStateData(statesMap, statesDetails);

    const existingStates = await LotteryState.find({
      country: COUNTRY_CODE.toUpperCase(),
    }).lean();
    const existingMap = new Map(
      existingStates.map((state) => [state.code, state])
    );

    const { insertOps, updateOps, skipped } = computeDiff(
      incomingStates,
      existingMap
    );

    const bulkOps = [];
    if (insertOps.length) {
      insertOps.forEach((op) => bulkOps.push({ insertOne: op }));
    }
    if (updateOps.length) {
      updateOps.forEach((op) => bulkOps.push({ updateOne: op }));
    }

    if (bulkOps.length) {
      await LotteryState.bulkWrite(bulkOps, { ordered: false });
    }

    const refreshedStates = await LotteryState.find({
      country: COUNTRY_CODE.toUpperCase(),
    })
      .sort({ code: 1 })
      .lean();

    return successResponse(res, "Lottery states synced successfully", {
      inserted: insertOps.length,
      updated: updateOps.length,
      skipped,
      totalStored: refreshedStates.length,
      states: refreshedStates,
    });
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to sync lottery states";
    return errorResponse(res, message, 500);
  }
});

export const getStoredLotteryStates = asyncHandler(async (req, res) => {
  // Auto-sync if DB empty, otherwise just read
  let states = await LotteryState.find({
    country: COUNTRY_CODE.toUpperCase(),
  })
    .sort({ code: 1 })
    .lean();

  if (!states.length) {
    // Run sync silently to populate
    await syncLotteryStates(req, res);
    return;
  }

  return successResponse(res, "Lottery states fetched successfully", {
    totalStored: states.length,
    states,
  });
});

export const getLotteriesByState = asyncHandler(async (req, res) => {
  const state = (req.query.state || "").toLowerCase().trim();
  if (!state) {
    return errorResponse(res, "state query param is required", 400);
  }

  try {
    const client = lotteryApiClient();
    const response = await client.get("/lottery/lotteries", {
      params: { country: COUNTRY_CODE, state },
    });

    return successResponse(res, "Lotteries fetched successfully", response.data);
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch lotteries";
    return errorResponse(res, message, 500);
  }
});

export const getLotteryResults = asyncHandler(async (req, res) => {
  const id = Number(req.query.id);
  const year = req.query.year ? Number(req.query.year) : undefined;

  if (!id || Number.isNaN(id)) {
    return errorResponse(res, "id query param is required and must be a number", 400);
  }

  try {
    const client = lotteryApiClient();
    const response = await client.get("/lottery/results", {
      params: { id, year, country: COUNTRY_CODE },
    });

    const lotteryInfo = response?.data?.lottery || null;
    const results = response?.data?.results || [];

    // Upsert results (no duplicates)
    if (Array.isArray(results) && results.length) {
      const bulkOps = results.map((item) => {
        const drawDate = item.draw_date || item.drawDate;
        return {
          updateOne: {
            filter: { lotteryId: id, drawDate },
            update: {
              $set: {
                lotteryId: id,
                country: COUNTRY_CODE.toUpperCase(),
                state: lotteryInfo?.state ?? null,
                drawDate,
                balls: (item.balls || []).map(Number),
                ballBonus: item.ball_bonus != null ? Number(item.ball_bonus) : null,
                jackpot: item.jackpot ?? null,
                lotteryInfo,
                raw: item,
              },
            },
            upsert: true,
          },
        };
      });

      if (bulkOps.length) {
        await LotteryResult.bulkWrite(bulkOps, { ordered: false });
      }
    }

    // Return stored data filtered by lotteryId and optional year
    const query = { lotteryId: id };
    if (year) {
      query.drawDate = { $regex: `^${year}-` }; // YYYY- prefix
    }
    const stored = await LotteryResult.find(query).sort({ drawDate: -1 }).lean();

    return successResponse(res, "Lottery results fetched successfully", {
      lottery: lotteryInfo,
      totalStored: stored.length,
      results: stored,
    });
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch lottery results";
    return errorResponse(res, message, 500);
  }
});

export const getLotteryFrequency = asyncHandler(async (req, res) => {
  const id = Number(req.query.id);
  const yearParam = req.query.year ? Number(req.query.year) : null;
  const drawDateFrom = req.query.draw_date_from || null;
  const drawDateTo = req.query.draw_date_to || null;

  if (!id || Number.isNaN(id)) {
    return errorResponse(res, "id query param is required and must be a number", 400);
  }

  // If date range provided, prioritize it and ignore year (so client requests with both still work)
  const year = drawDateFrom || drawDateTo ? null : yearParam;

  try {
    const client = lotteryApiClient();
    const response = await client.get("/lottery/frequency", {
      params: {
        id,
        year: year || undefined,
        draw_date_from: drawDateFrom || undefined,
        draw_date_to: drawDateTo || undefined,
        country: COUNTRY_CODE,
      },
    });

    const lotteryInfo = response?.data?.lottery || null;
    const filters = response?.data?.filters || null;
    const frequency = response?.data?.frequency || null;

    // Upsert frequency snapshot (unique per lottery + year/date range)
    await LotteryFrequency.updateOne(
      {
        lotteryId: id,
        year: year ?? null,
        drawDateFrom: drawDateFrom ?? null,
        drawDateTo: drawDateTo ?? null,
      },
      {
        $set: {
          lotteryId: id,
          country: COUNTRY_CODE.toUpperCase(),
          year: year ?? null,
          drawDateFrom: drawDateFrom ?? null,
          drawDateTo: drawDateTo ?? null,
          filters,
          frequency,
          lotteryInfo,
          raw: response?.data ?? null,
        },
      },
      { upsert: true }
    );

    const stored = await LotteryFrequency.findOne({
      lotteryId: id,
      year: year ?? null,
      drawDateFrom: drawDateFrom ?? null,
      drawDateTo: drawDateTo ?? null,
    }).lean();

    return successResponse(res, "Lottery frequency fetched successfully", stored);
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch lottery frequency";
    return errorResponse(res, message, 500);
  }
});
