const Caisse = require("../../database/dbModels/Caisse");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { exportPaymentReport } = require("../Reports/Payments");

async function handlePaymentReport(text, requestData, isAdmin, context) {
	const { userId, channelId } = requestData;

	if (!isAdmin) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { status: 200, body: "" };
	}

	setImmediate(async () => {
		const args = text.trim().split(" ").slice(1);
		if (args.length < 2) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Usage: /payment report [payment|project|date|status|user] [value]\nExemples:\n• /payment report payment PAY/2025/03/0001\n• /payment report project general\n• /payment report date 2025-03-01\n• /payment report status 'En attente'\n• /payment report user U1234567890",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}

		const [reportType, ...valueParts] = args;
		const value = valueParts.join(" ");

		try {
			await exportPaymentReport(context, reportType, value, userId, channelId);
			return { status: 200, body: "" };
		} catch (error) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: `❌ Erreur lors de la génération du rapport de paiement : ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
	});
}
async function handleBalanceCheck(channelId) {
	const caisse = await Caisse.findOne().sort({ _id: -1 });

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: channelId,
			text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return { status: 200, body: "" };
}

module.exports = {
	handlePaymentReport,
	handleBalanceCheck,
};
