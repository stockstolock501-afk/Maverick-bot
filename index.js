require('dotenv').config();
var express     = require('express');
var TelegramBot = require('node-telegram-bot-api');
var WebSocket   = require('ws');
var fetch       = require('node-fetch');
var path        = require('path');

// ENV
var TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
var FINNHUB_KEY    = process.env.FINNHUB_KEY;
var GROQ_KEY       = process.env.GROQ_KEY;
var GROQ_KEY_2     = process.env.GROQ_KEY_2;   // Optional: second Groq key
var GROQ_KEY_3     = process.env.GROQ_KEY_3;   // Optional: third Groq key
var CEREBRAS_KEY   = process.env.CEREBRAS_KEY; // Optional: free at inference.cerebras.ai
var JSONBIN_KEY    = process.env.JSONBIN_KEY;
var JSONBIN_BIN    = process.env.JSONBIN_BIN;
var WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'maverick';
var TG_CHAT_ID     = process.env.TG_CHAT_ID;
var BOT_USERNAME   = process.env.TG_BOT_USERNAME || '';
var PORT           = process.env.PORT || 3000;