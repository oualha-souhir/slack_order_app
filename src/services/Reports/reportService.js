// src/reportService.js
const { OpenAI } = require("openai");
const cron = require("node-cron");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const Order = require("../../database/dbModels/Order");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let isScheduledR = false;

// Generate payment and order report
async function generateReport(context) {
	console.log("** generateReport");
	const orders = await Order.find({}).sort({ date: -1 }).limit(100);
	const totalOrders = orders.length;

	// Calculate total paid by currency
	const totalPaidByCurrency = orders.reduce((acc, o) => {
		o.proformas.forEach((p) => {
			const currency = p.devise || "XOF"; // Default to XOF if currency is missing
			acc[currency] = (acc[currency] || 0) + (p.montant || 0);
		});
		return acc;
	}, {});

	const pendingOrders = orders.filter((o) => o.statut === "En attente").length;

	// const orderData = orders.map((o) => {
	// 	const amountByCurrency = o.proformas.reduce((acc, p) => {
	// 		const currency = p.devise || "XOF";
	// 		acc[currency] = (acc[currency] || 0) + (p.montant || 0);
	// 		return acc;
	// 	}, {});

	// 	return {
	// 		id: o.id_commande,
	// 		amount: amountByCurrency,
	// 		date: o.date,
	// 		team: o.equipe,
	// 	};
	// });

	// Format the totals for display
	const currencyTotals = Object.entries(totalPaidByCurrency)
		.map(([currency, amount]) => `${amount} ${currency}`)
		.join(", ");

	const reportText = `
    *Rapport Automatisé (dernières 100 commandes)*
    - Total commandes: ${totalOrders}
    - Commandes en attente: ${pendingOrders}
    - Total payé: ${currencyTotals || "0 XOF"}
  `;

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: reportText,
		},
		process.env.SLACK_BOT_TOKEN
	);

	context.log(`Report sent: ${reportText}`);
}
// Analyze trends and detect anomalies
async function analyzeTrends(context) {
	console.log("** analyzeTrends");
	const orders = await Order.find({}).sort({ date: -1 }).limit(100);
	const orderData = orders.map((o) => {
		const amountByCurrency = o.proformas.reduce((acc, p) => {
			const currency = p.devise || "XOF"; // Assumer XOF par défaut si la devise est manquante
			acc[currency] = (acc[currency] || 0) + (p.montant || 0);
			return acc;
		}, {});

		return {
			id: o.id_commande,
			amount: amountByCurrency, // Ex: { "XOF": 50000, "EUR": 200, "USD": 100 }
			date: o.date,
			team: o.equipe,
		};
	});
	const prompt = `
    Analyze these orders: ${JSON.stringify(orderData)}
    Identify:
    - Top 3 teams by order volume
    - Average order amount (be careful about the currency)
    - Anomalies (e.g., sudden spending spikes > 50% above average)
    - Analyser les proformas et comparer les prix avec des historiques pour détecter des écarts anormaux.
    Return JSON: { "teams": ["team1", "team2", "team3"], "avgAmount": ["number":"XOF", "number":"EUR", "number":"USD"], "anomalies": ["description"], "Analyse": ["description"]}
  `;

	const response = await openai.chat.completions.create({
		model: "gpt-3.5-turbo",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 200,
	});

	const result = JSON.parse(response.choices[0].message.content.trim());
	context.log(`Trend analysis: ${JSON.stringify(result)}`);

	if (result.anomalies.length > 0) {
		const alertText = `
      *Alerte sur les Tendances*
      - Top équipes: ${result.teams.join(", ")}
- Montant moyen: ${Object.entries(result.avgAmount)
			.map(([currency, amount]) => `${amount} ${currency}`)
			.join(", ")}      
      - Anomalies: ${result.anomalies.join(", ")}
      - Analyse :  ${result.Analyse.join(", ")}
    `;
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: alertText,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

// Schedule reports and trend analysis (e.g., daily at 9 AM)
function setupReporting(context) {
	console.log("** setupReporting");
	if (isScheduledR) {
		console.log("Reporting already scheduled, skipping duplicate setup.");
		return;
	}
	cron.schedule("40 12 * * *", async () => {
		await generateReport(context);
		await analyzeTrends(context);
	});
	isScheduledR = true; // Set after scheduling
	console.log("Delay monitoring scheduled to run 12pm.");
}

module.exports = {
	generateReport,
	analyzeTrends,
	setupReporting,
};
