const TelegramBot = require("node-telegram-bot-api");

// Replace with your bot token
const bot = new TelegramBot("8120656848:AAFu2UyL4Dl6S4pXpTbcl3BVwj0CAcLjdCU", { polling: true });

bot.on("message", (msg) => {
    console.log("CHAT ID:", msg.chat.id);
    console.log("Username:", msg.from.username);
    console.log("Name:", msg.from.first_name, msg.from.last_name || "");
});
