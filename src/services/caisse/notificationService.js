const Caisse = require("../../database/dbModels/Caisse");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const { generateRequestDetailBlocks } = require("./blockBuilders");

require("dotenv").config(); // To load environment variables

// Notify admin about refund request
async function notifyAdminRefund(request, context) {
	console.log("** notifyAdminRefund");

	// Get current caisse balances
	const caisse = await Caisse.findOne();
	const balances = caisse ? caisse.balances : { XOF: 0, USD: 0, EUR: 0 };

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de Fonds: ${request.requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				...generateRequestDetailBlocks(request),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${balances.XOF}*, USD: *${balances.USD}*, EUR: *${balances.EUR}*`,
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Pré-approuver", emoji: true },
							style: "primary",
							value: request.requestId,
							action_id: "pre_approve_funding",
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: request.requestId,
							action_id: "reject_fund",
						},
					],
				},
			],
			text: `Nouvelle demande de fonds: ${request.amount} ${request.currency} pour "${request.reason}" (ID: ${request.requestId})`,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}

// Notify user about refund request
async function notifyUserRefund(request, userId, context) {
	console.log("** notifyUserRefund");

	// Get current caisse balances
	const caisse = await Caisse.findOne();
	const balances = caisse ? caisse.balances : { XOF: 0, USD: 0, EUR: 0 };

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: userId,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de Fonds",
						emoji: true,
					},
				},
				...generateRequestDetailBlocks(request),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${balances.XOF}*, USD: *${balances.USD}*, EUR: *${balances.EUR}*\n ✅ Votre demande de fonds a été soumise. Vous serez notifié lorsqu'elle sera traitée.`,
						},
					],
				},
			],
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
module.exports = {
	notifyAdminRefund,
	notifyUserRefund,
	generateRequestDetailBlocks,
};
