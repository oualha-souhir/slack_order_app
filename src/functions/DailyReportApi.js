const Order = require("../database/dbModels/Order");
const { createSlackResponse } = require("../Handlers/slackApiUtils");
const { handleAICommand } = require("../services/aiService");
const { notifyUserAI } = require("../services/Order/orderNotificationService");
const {
	generateReport,
	analyzeTrends,
} = require("../services/Reports/reportService");
const { app } = require("@azure/functions");
const { OpenAI } = require("openai");
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
require("dotenv").config(); // Load environment variables from .env file


app.timer("dailyReport", {
	schedule: "0 5 9 * * *", // Daily at 9:05 AM

	handler: async (timer, context) => {
		context.log("Running daily report");
		await generateReport(context); 
		await analyzeTrends(context);
		await handleAICommand(
			context, // Assuming logger is correctly defined
			openai, // OpenAI client instance
			Order, // Mongoose model for orders
			notifyUserAI, // Function for sending notifications
			createSlackResponse // Function for formatting Slack responses
		);
		context.log("Daily report completed");
	},
});

