import { Reveal, SectionHeader } from "../ui/primitives";
import { COMPARE_ROWS, DOCS } from "../data";

export default function Compare() {
	return (
		<section id="compare" className="section" aria-labelledby="compare-title">
			<div className="container">
				<SectionHeader
					index="11"
					eyebrow="Peers vs native tasks"
					title={<span id="compare-title">Two lifetimes. Pick the one the work needs.</span>}
					lead="Use a native task for a bounded coding or research subtask. Use a peer when the work must own rooms, a schedule, or a life after this run."
					align="center"
				/>
				<Reveal className="compare-wrap" y={24}>
					<table className="compare">
						<caption className="sr-only">Native OMP task agents compared with oh-my-agent peers</caption>
						<thead>
							<tr>
								<th scope="col">
									<span className="sr-only">Property</span>
								</th>
								<th scope="col">Native OMP task</th>
								<th scope="col" className="is-peer">
									oh-my-agent peer
								</th>
							</tr>
						</thead>
						<tbody>
							{COMPARE_ROWS.map((row) => (
								<tr key={row.label}>
									<th scope="row">{row.label}</th>
									<td className={row.task === "—" ? "is-empty" : ""}>{row.task}</td>
									<td className="is-peer">{row.peer}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Reveal>
				<p className="fine-print is-center">
					Sources:{" "}
					<a className="text-link" href={DOCS.concepts} target="_blank" rel="noreferrer">
						concepts guide
					</a>{" "}
					and{" "}
					<a className="text-link" href={DOCS.architecture} target="_blank" rel="noreferrer">
						ARCHITECTURE.md
					</a>
					.
				</p>
			</div>
		</section>
	);
}
