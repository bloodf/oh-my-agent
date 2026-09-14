import Hero from "@site/components/home/hero/Hero";
import Daemon from "@site/components/home/sections/Daemon";
import Rooms from "@site/components/home/sections/Rooms";
import Hierarchy from "@site/components/home/sections/Hierarchy";
import Artifacts from "@site/components/home/sections/Artifacts";
import Schedules from "@site/components/home/sections/Schedules";
import Quota from "@site/components/home/sections/Quota";
import Isolation from "@site/components/home/sections/Isolation";
import Clients from "@site/components/home/sections/Clients";
import Remote from "@site/components/home/sections/Remote";
import QuickStart from "@site/components/home/sections/QuickStart";
import Compare from "@site/components/home/sections/Compare";
import DemoTeaser from "@site/components/home/sections/DemoTeaser";
import FinalCta from "@site/components/home/sections/FinalCta";
import Footer from "@site/components/home/sections/Footer";
import { Nav, ScrollProgress, SmoothScroll } from "@site/components/home/ui/chrome";

// Story order: the session closes (hero), why the work survives (daemon), how
// agents talk (rooms), who answers to whom (hierarchy), what they hand back
// (artifacts), when they work (schedules), what stops them (quota, isolation),
// how you watch (clients, remote), then the way in.
export default function HomePage() {
	return (
		<SmoothScroll>
			<ScrollProgress />
			<Nav />
			<main id="main">
				<Hero />
				<Daemon />
				<Rooms />
				<Hierarchy />
				<Artifacts />
				<Schedules />
				<Quota />
				<Isolation />
				<Clients />
				<Remote />
				<QuickStart />
				<Compare />
				<DemoTeaser />
				<FinalCta />
			</main>
			<Footer />
		</SmoothScroll>
	);
}
