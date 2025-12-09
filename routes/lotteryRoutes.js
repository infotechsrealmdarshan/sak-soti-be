import express from "express";
import {
  getLotteriesByState,
  getLotteryFrequency,
  getLotteryResults,
  getStoredLotteryStates,
  syncLotteryStates,
} from "../controller/lotteryController.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Lottery
 *   description: Lottery states sync and retrieval
 */

/**
 * @swagger
 * /api/lottery/states/local:
 *   get:
 *     summary: Get stored lottery states (US only)
 *     tags: [Lottery]
 *     responses:
 *       200:
 *         description: Stored states fetched successfully
 *       500:
 *         description: Server error
 */
// GET: pull from DB only (local cache)
router.get("/states/local", getStoredLotteryStates);

/**
 * @swagger
 * /api/lottery/states:
 *   get:
 *     summary: lottery states from third-party API and return stored data
 *     description: Fetches US states from Lottery Results Feed, upserts into DB (no duplicates), then returns stored data.
 *     tags: [Lottery]
 *     responses:
 *       200:
 *         description: completed with inserted/updated counts and stored states
 *       500:
 *         description: Server error
 */
// GET: fetch from third-party, store (idempotent), and return stored data
router.get("/states", syncLotteryStates);

/**
 * @swagger
 * /api/lottery/lotteries:
 *   get:
 *     summary: Get lotteries by state (country fixed to US)
 *     tags: [Lottery]
 *     parameters:
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *           example: az
 *         description: US state code (e.g., az, ca, ny). Country is fixed to "us".
 *     responses:
 *       200:
 *         description: Lotteries fetched successfully
 *       400:
 *         description: Missing or invalid state
 *       500:
 *         description: Server error
 */
router.get("/lotteries", getLotteriesByState);

/**
 * @swagger
 * /api/lottery/results:
 *   get:
 *     summary: Get lottery results (stores to DB, no duplicates) for US
 *     tags: [Lottery]
 *     parameters:
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           example: 1
 *         description: Lottery ID
 *       - in: query
 *         name: year
 *         required: false
 *         schema:
 *           type: integer
 *           example: 2025
 *         description: Optional year filter (YYYY). Country is fixed to "us".
 *     responses:
 *       200:
 *         description: Results fetched (and stored) successfully
 *       400:
 *         description: Missing/invalid params
 *       500:
 *         description: Server error
 */
router.get("/results", getLotteryResults);

/**
 * @swagger
 * /api/lottery/frequency:
 *   get:
 *     summary: Get lottery number frequency (stores snapshot to DB, no duplicates) for US
 *     tags: [Lottery]
 *     parameters:
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           example: 1
 *         description: Lottery ID
 *       - in: query
 *         name: year
 *         required: false
 *         schema:
 *           type: integer
 *           example: 2024
 *         description: Optional year filter. If draw_date_from/to are provided, year is ignored. Country is fixed to "us".
 *       - in: query
 *         name: draw_date_from
 *         required: false
 *         schema:
 *           type: string
 *           example: "2024-01-01"
 *       - in: query
 *         name: draw_date_to
 *         required: false
 *         schema:
 *           type: string
 *           example: "2024-06-30"
 *     responses:
 *       200:
 *         description: Frequency fetched (and stored) successfully
 *       400:
 *         description: Missing/invalid params
 *       500:
 *         description: Server error
 */
router.get("/frequency", getLotteryFrequency);

export default router;

