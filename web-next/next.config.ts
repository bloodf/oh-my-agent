import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Every page reads the live daemon; nothing here is static.
	// Two lockfiles sit above this app (the repo's and this one's); the app
	// itself is the root, not the repository.
	turbopack: { root: __dirname },
	poweredByHeader: false,
	reactStrictMode: true,
};

export default nextConfig;
