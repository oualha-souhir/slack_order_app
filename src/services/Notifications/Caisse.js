const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");

async function showCaisseOptions(userId, channelId) {
	setImmediate(async () => {
		try {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: "💰 Demande de Fonds",
								emoji: true,
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Bonjour <@${userId}> ! Voici comment créer une demande de remboursement :`,
							},
						},
						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 1:* Créez une demande rapide avec la syntaxe suivante:",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "```\n/caisse montant: [montant] devise: [XOF/USD/EUR] motif: [raison] date requise: yyyy-mm-dd\n```",
							},
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "💡 *Exemple:* `/caisse montant: 15000 devise: XOF motif: Solde XOF insuffisant date requise: 2025-12-12`",
								},
							],
						},
						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 2:* Utilisez le formulaire interactif ci-dessous",
							},
						},
						{
							type: "actions",
							elements: [
								{
									type: "button",
									text: {
										type: "plain_text",
										text: "📋 Ouvrir le formulaire",
										emoji: true,
									},
									style: "primary",
									action_id: "open_funding_form",
									value: "open_form",
								},
							],
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "ℹ️ *Devises acceptées:* XOF, USD, EUR",
								},
							],
						},
					],
					text: `💰 Bonjour <@${userId}> ! Pour créer une demande de remboursement, utilisez la commande directe ou le formulaire.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		} catch (error) {
			console.error("Error in async processing:", error);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Une erreur inattendue s'est produite. Veuillez réessayer plus tard.",
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return { status: 200, body: "" };
}
module.exports = {
	showCaisseOptions,
};
