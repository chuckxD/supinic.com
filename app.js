(async function () {
	"use strict";

	process.env.PROJECT_TYPE = "site";

	require("./db-access.js");
	await require("supinic-globals")(["objects", "singletons"]);

	// @todo please remove this and make supinic-globals take more params on what to load
	// what the hell.
	sb.User = await (await require("../custom_modules/supinic-globals/classes/user.js")).initialize();
	sb.WebUtils = require("./webutils");

	const port = 80;
	const crypto = require("crypto");
	const request = require("request");
	const bodyParser = require("body-parser");
	const Express = require("express");
	const Session = require("express-session");
	const Passport = require("passport");
	const { OAuth2Strategy } = require("passport-oauth");
	const CacheController = require("express-cache-controller");

	const UserAlias = require("./modules/chat-data/user-alias.js");
	
	class Strategy extends OAuth2Strategy {
		userProfile (accessToken, done) {
			const options = {
				url: "https://api.twitch.tv/helix/users",
				method: "GET",
				headers: {
					Authorization: "Bearer " + accessToken
				}
			};
			
			request(options, (err, resp, body) => {
				if (resp && resp.statusCode === 200) {
					done(null, JSON.parse(body));
				}
				else {
					done(JSON.parse(body));
				}
			});
		}
	}
	
	const app = Express();

	app.use(Session({
		secret: crypto.randomBytes(16).toString(), // SESSION_SECRET
		resave: false,
		saveUninitialized: false
	}));
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));
	app.use(CacheController({
		noCache: true
	}));
	app.use("/public", Express.static(__dirname + "/public/"));
	app.use("/api", Express.static(__dirname + "/apidocs/"));

	app.use(Passport.initialize());
	app.use(Passport.session());
	
	Passport.serializeUser((user, done) => done(null, user));
	Passport.deserializeUser((user, done) => done(null, user));
	Passport.use("twitch", new Strategy(
		{
			authorizationURL: "https://id.twitch.tv/oauth2/authorize",
			tokenURL: "https://id.twitch.tv/oauth2/token",
			clientID: sb.Config.get("WEBSITE_TWITCH_CLIENT_ID"),
			clientSecret: sb.Config.get("WEBSITE_TWITCH_CLIENT_SECRET"),
			callbackURL: sb.Config.get("WEBSITE_TWITCH_CALLBACK_URL"),
			// state: true
		},
		(access, refresh, profile, done) => {
			profile.accessToken = access;
			profile.refreshToken = refresh;
			// @todo Store user?
			done(null, profile);
		}
	));

	app.locals.navitems = [
		{
			name: "Chat bot",
			link: "bot",
			items: [
				{ name: "Channel data", link: "channels" },
				{ name: "Cookie statistics", link: "cookie/list" },
				{ name: "Commands", link: "command" },
				{ name: "Commands statistics", link: "command/stats" },
				{ name: "Playsounds", link: "playsound" },
				{ name: "Reminders - yours", link: "reminder/list" },
				{ name: "Slots winners list", link: "slots-winner/list" },
				{ name: "Suggestions - all", link: "suggestions/list" },
				{ name: "Suggestions - yours", link: "suggestions/mine" },
				{ name: "Suggestions - your stats", link: "suggestions/stats" }
			]
		},
		{
			name: "Channel bots",
			link: "bot",
			items: [
				{ name: "Program info", link: "channel-bots" },
				{ name: "Bots", link: "channel-bots" },
				{ name: "Badges", link: "channel-bots/badges" },
				{ name: "Levels", link: "channel-bots/levels" }
			]
		},
		{
			name: "Gachi",
			link: "gachi",
			items: [
				{ name: "List", link: "list" },
				// { name: "Add new", link: "add" },
				// { name: "Guidelines", link: "guidelines" },
				// { name: "Todo list", link: "todo" },
				{ name: "Archive", link: "archive" },
				{ name: "Resources", link: "resources" }
			]
		},
		{
			name: "Tracks",
			link: "track",
			items: [
				{ name: "Todo", link: "todo/list" },
			]
		},
		{
			name: "Stream",
			link: "stream",
			items: [
				{ name: "TTS voices", link: "tts" },
				{ name: "Video request queue", link: "video-queue" }
			]
		},
		{
			name: "Emote origins",
			link: "origin"
		},
		{
			name: "API",
			link: "api"
		},
		{
			name: "Contact",
			link: "contact"
		}
	];
	app.set("view engine", "pug");
	
	// robots.txt - disallow everything
	app.get("/robots.txt", (req, res) => {
		res.type("text/plain");
		res.send("User-agent: Googlebot\nAllow: /\nUser-Agent: *\nDisallow: /");
	});	

	await app.all("*", async (req, res, next) => {
		app.locals.currentLocation = req.originalUrl;

		if (req.session.passport) {
			const data = req.session.passport.user.data[0];
			const userData = await sb.User.get(data.login, false);

			res.locals.authUser = {
				login: data.login,
				display: data.display_name,
				id: data.id,
				image: data.profile_image_url,
				admin: data.login === "supinic",
				userData: userData
			};

			res.locals.level = {
				isLogin: () => true,
				isEditor: () => Boolean(userData.Data.trackEditor || userData.Data.trackModerator || userData.Data.trackAdmin),
				isModerator: () => Boolean(userData.Data.trackModerator || userData.Data.trackAdmin),
				isAdmin: () => Boolean(userData.Data.trackAdmin),
			}
		}

		next();
	});

	app.get("/", (req, res) => res.render("index"));
	app.locals.navitems.forEach(routeData => app.use("/" + routeData.link, require("./routes/" + routeData.link)));
	app.use("/track", require("./routes/track"));

	app.use("/api", require("./routes/api"));
	app.use("/rss", require("./routes/rss.js"));

	// @deprecated redirect to new commands endpoint
	app.use("/bot/commands*", (req, res) => res.redirect("/bot/command/list"));

	// Twitch auth
	app.get("/auth/twitch", (req, res, next) => {
		const { returnTo } = req.query;
		const state = (returnTo)
			? Buffer.from(JSON.stringify({returnTo})).toString("base64")
			: undefined;

		const authenticator = Passport.authenticate("twitch", { scope: "", state });
		authenticator(req, res, next);
	});

	app.get("/auth/twitch/callback", Passport.authenticate("twitch", { failureRedirect: "/wcs" }), async (req, res) => {
		try {
			const { state } = req.query;
			const { returnTo } = JSON.parse(Buffer.from(state, "base64").toString());
			if (typeof returnTo === "string" && returnTo.startsWith("/")) {
				return res.redirect(returnTo);
			}
		}
		catch {
			console.warn("Redirect not applicable", res);
		}

		res.redirect("/contact");
	});

	// Paypal
	app.post("/paypal", (req, res) => {
		const parsedData = {
			id: req.body.id,
			created: new sb.Date(req.body.create_time).valueOf(),
			summary: req.body.summary,
			state: req.body.resource.state,
			mode: req.body.resource.amount.mode,
			currency: req.body.resource.amount.currency,
			amount: Number(req.body.resource.amount.total)
		};

		const params = new sb.URLParams().set("type", "paypal");
		for (const [key, value] of Object.entries(parsedData)) {
			params.set(key, value);
		}
		sb.InternalRequest.send(params);

		res.status(200).end();
	});

	// 404
	app.get("*", (req, res) => {
		return res.status(401).render("error", {
			message: "404 Not found",
			error: "Endpoint was not found"
		});
	});

	app.listen(port, () => console.log("Listening..."));

	sb.App = app;
})();	