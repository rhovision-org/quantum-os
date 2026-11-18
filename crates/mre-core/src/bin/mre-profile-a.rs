//! Native JSON-line transport for exact-rational Profile A. Read-only; no chain access.
use mre_core::{canonical, parse_rational, update};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    prior: String,
    likelihood_given_h: String,
    likelihood_given_not_h: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    evidence: String,
    posterior_given_e: String,
    posterior_given_not_e: Option<String>,
}
fn run(line: &str) -> Result<String, &'static str> {
    let req: Request = serde_json::from_str(line).map_err(|_| "invalid-request")?;
    let p = parse_rational(&req.prior).map_err(|_| "invalid-prior")?;
    let a = parse_rational(&req.likelihood_given_h).map_err(|_| "invalid-likelihood")?;
    let b = parse_rational(&req.likelihood_given_not_h).map_err(|_| "invalid-likelihood")?;
    let result = update(&p, &a, &b).map_err(|_| "invalid-probability-domain")?;
    serde_json::to_string(&Response {
        evidence: canonical(&result.evidence),
        posterior_given_e: canonical(&result.posterior_given_e),
        posterior_given_not_e: result.posterior_given_not_e.as_ref().map(canonical),
    })
    .map_err(|_| "serialization-failed")
}
fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            std::process::exit(2)
        };
        match run(&line) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
}
