const {
	handleCaisseCommand,
} = require("../services/caisse/fundingRequestService");
const {
	handlePaymentCommand,
} = require("../services/Payment/paymentCommandService");

const { handleOrderCommand } = require("../services/Order/orderCommandHandler");

const {
	isAdminUser,
	isFinanceUser,
	isPurchaseUser,
} = require("../services/UserManagement");
const OpenAI = require("openai").default;
const { createSlackResponse } = require("./slackApiUtils");

async function handleOrderSlackApi(request, context) {
	console.log("** handleOrderSlackApi");

	const logger = {
		log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
	};

	const openai = new OpenAI({
		apiKey: process.env.OPENAI_API_KEY,
	});

	try {
		console.log("Delay monitoring test completed");
		context.log("📩 Commande Slack reçue !");
		// const body = await request.json();
		// if (body.type === "url_verification") {
		//   return { status: 200, body: body.challenge };
		// }
		const body = await request.text();
		const params = new URLSearchParams(body);
		const requestData = {
			command: params.get("command"),
			text: params.get("text") || "",
			userId: params.get("user_id"),
			userName: params.get("user_name"),
			channelId: params.get("channel_id"),
			channelName: params.get("channel_name"),
			triggerId: params.get("trigger_id"),
		};

		context.log(
			`Command: ${requestData.command}, Text: ${requestData.text}, User ID: ${requestData.userId}, User Name: ${requestData.userName}, Channel ID: ${requestData.channelId}`
		);

		// Get user permissions
		const userPermissions = {
			isAdmin: await isAdminUser(requestData.userId),
			isFinance: await isFinanceUser(requestData.userId),
			isPurchase: await isPurchaseUser(requestData.userId),
		};

		// Route to appropriate command handler
		switch (requestData.command) {
			case "/caisse-test":
				console.log("⚡ Caisse System is running!");
				return await handleCaisseCommand(
					requestData,
					userPermissions,
					logger,
					context
				);

			case "/payment-test":
				console.log("⚡ Payment System is running!");
				return await handlePaymentCommand(
					requestData,
					userPermissions,
					logger,
					context
				);

			case "/order-test":
				console.log("Order Management System is running!");
				return await handleOrderCommand(
					requestData,
					userPermissions,
					logger,
					context,
					openai
				);

			case "/order":
			case "/payment":
			case "/caisse":
				// Handle production commands if needed
				break;

			default:
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "❓ Commande inconnue. Utilisez `/order help` pour voir les commandes disponibles.",
				});
		}
	} catch (error) {
		context.log(`❌ Erreur: ${error.stack}`);
		return createSlackResponse(500, "Erreur interne");
	}
}
module.exports = {
	handleOrderSlackApi,
};
