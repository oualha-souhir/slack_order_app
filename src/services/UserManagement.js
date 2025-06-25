const UserRole = require("../database/dbModels/UserRole");

const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../Handlers/slackApiUtils");
const { getSlackUserName, resolveUserIdAndName } = require("../Handlers/Utils");
const axios = require("axios");

async function handleAddRole(text, requestData, isAdmin) {
	const { channelId } = requestData;

	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Seuls les administrateurs peuvent ajouter des rôles.",
		});
	}

	const [, mention, role] = text.trim().split(" ");
	if (role !== "admin" && role !== "finance" && role !== "achat") {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: channelId,
				text: "🚫 Invalid role. Only 'admin', 'finance', or 'achat' are allowed.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { status: 200, body: "" };
	}

	let userIdToAdd, userNameToAdd;
	if (mention.startsWith("<@")) {
		userIdToAdd = mention.replace(/[<@>]/g, "");
		userNameToAdd = await getSlackUserName(userIdToAdd);
	} else {
		const identifier = mention.replace(/^../, "");
		const resolved = await resolveUserIdAndName(identifier);
		userIdToAdd = resolved.userId;
		userNameToAdd = resolved.userName;
	}

	console.log(`Adding role ${role} to user ${userIdToAdd} (${userNameToAdd})`);
	await addUserRole(userIdToAdd, role, userNameToAdd);

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: `✅ Rôle ${role} ajouté à <@${userIdToAdd}>.`,
	});
}
async function handleHelp(userPermissions) {
	const { isAdmin, isFinance, isPurchase } = userPermissions;

	let helpText = "*🛠️ Commandes disponibles:*\n\n";

	if (isAdmin) {
		helpText += "*Commandes pour les administrateurs:*\n";
		helpText += "*Configuration:*\n";
		helpText += "• `/order config` - Ouvrir le panneau de configuration\n";
		helpText +=
			"• `/order add [equipe|unit|currency] <valeur>` - Ajouter une option\n";
		helpText +=
			"• `/order remove [equipe|unit|currency] <valeur>` - Supprimer une option\n\n";
		helpText += "*Gestion des rôles:*\n";
		helpText +=
			"• `/order add-role @user [admin|finance|achat]` - Ajouter un rôle\n";
		helpText +=
			"• `/order rm-role @user [admin|finance|achat]` - Retirer un rôle\n\n";
		helpText += "• `/order delete <order_id>` - Supprimer une commande\n";
	}

	if (isAdmin || isFinance || isPurchase) {
		helpText +=
			"*Commandes pour les administrateurs, les équipes financières et les équipes d'achat:*\n";
		helpText += "• `/order summary` - Générer un résumé global\n";
		helpText +=
			"• `/order report [order|channel|date|status|user|team] <valeur>` - Générer un rapport de commandes\n";
		helpText +=
			"• `/payment report [payment|channel|date|status|user] <valeur>` - Générer un rapport de paiements\n";
		helpText += "• `/order check-delays` - Vérifier les retards\n";
		helpText += "• `/order list detailed` - Liste détaillée des commandes\n";
		helpText += "• `/order list` - Liste des commandes récentes\n";
		helpText +=
			"• `/order filterby [titre|status|demandeur|équipe]:<valeur>` - Filtrer les commandes\n";
		helpText += "• `/order resume` - Résumé IA des commandes\n";
	}

	if (isAdmin || isFinance) {
		helpText += "*Commandes pour les finances:*\n";
		helpText += "• `/caisse balance` - Afficher le solde de la caisse\n";
		helpText += "• `/caisse` - Créer une demande de fonds\n";
	}

	helpText += "*Commandes générales:*\n";
	helpText += "• `/order ask ai: <question>` - Poser une question à l'IA\n";
	helpText += "• `/order my order` - Voir votre dernière commande\n";
	helpText += "• `/payment` - Créer une demande de paiement\n";
	helpText += "• `/order` - Créer une commande\n";

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: helpText,
	});
}
async function handleRemoveRole(text, isAdmin) {

	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Seuls les administrateurs peuvent supprimer des rôles.",
		});
	}

	const [, mention, role] = text.trim().split(" ");
	let userIdToRemove;

	if (mention.startsWith("<@")) {
		userIdToRemove = mention.replace(/[<@>]/g, "");
	} else {
		const identifier = mention.replace(/^../, "");
		const resolved = await resolveUserIdAndName(identifier);
		userIdToRemove = resolved.userId;
	}

	await removeUserRole(userIdToRemove, role);

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: `✅ Rôle ${role} retiré de <@${userIdToRemove}>.`,
	});
}

async function handleListUsers(isAdmin) {
	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Seuls les administrateurs peuvent voir la liste des utilisateurs et rôles.",
		});
	}

	const users = await UserRole.find({});

	if (!users.length) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "Aucun utilisateur avec des rôles trouvés.",
		});
	}

	let text = "*👥 Liste des utilisateurs et rôles assignés:*\n";
	users.forEach((user) => {
		text += `• <@${user.userId}> : ${user.roles.join(", ")}\n`;
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text,
	});
}

async function getUserRoles(userId) {
	const user = await UserRole.findOne({ userId });
	return user ? user.roles : [];
}

async function isAdminUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("admin");
}
async function isFinanceUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("finance");
}
async function isPurchaseUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("achat");
}

async function addUserRole(userId, role, username) {
	await UserRole.updateOne(
		{ userId, username: username },
		{ $addToSet: { roles: role } },
		{ upsert: true }
	);
	// Notify the user via Slack DM
	try {
		await axios.post(
			"https://slack.com/api/chat.postMessage",
			{
				channel: userId,
				text: `Bonjour <@${userId}> ! Vous avez reçu le rôle *${role}* dans le système.\n\nTapez \`/order help\` pour voir les commandes disponibles pour votre rôle.`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/json",
				},
			}
		);
	} catch (err) {
		console.error("Erreur lors de la notification Slack :", err);
	}
}

async function removeUserRole(userId, role) {
	await UserRole.updateOne({ userId }, { $pull: { roles: role } });
}

module.exports = {
	handleAddRole,
	handleHelp,
	handleRemoveRole,
	handleListUsers,
	getUserRoles,
	isAdminUser,
	isFinanceUser,
	isPurchaseUser,
	addUserRole,
	removeUserRole,
};
