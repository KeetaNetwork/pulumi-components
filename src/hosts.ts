import { execSync } from 'child_process';

const foundHostCache: { [key: string]: string } = {};

const maxAttempts = 5;

/**
 * Get and add the domain from the TLS certificate to the hosts file
 * Note: This only works when the protocols that use starttls
 */
function getAndAddDomainFromHostTLS(url: string) {
	const parsed = new URL(url);

	const starttls = parsed.protocol.split(':')[0];

	let error;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const foundDomainResp = execSync(`echo '' | openssl s_client -connect ${parsed.host} -starttls ${starttls} 2>/dev/null | openssl x509 -ext subjectAltName -noout | awk '/DNS:/{ sub(/[[:space:]]*DNS:/, ""); print; }'`);
			const foundDomain = foundDomainResp.toString().trim();

			if (!foundDomain || foundDomain === '') {
				throw new Error('Could not find domain from TLS certificate');
			}

			if (foundDomain.includes(' ')) {
				throw new Error('Found multiple domains in TLS certificate, this is currently not supported');
			}

			execSync(`echo '${parsed.hostname} ${foundDomain} # Added Automatically by @keetapay/pulumi-components' | tee -a /etc/hosts`);

			return foundDomain;
		} catch (e) {
			error = e;
		}
	}

	throw error;
}

export function addSubjectAlternativeToHosts(url: string) {
	const parsed = new URL(url);
	const { hostname, protocol } = parsed;

	const updateKey = `${protocol}${hostname}`;

	if (foundHostCache[updateKey] === undefined) {
		foundHostCache[updateKey] = getAndAddDomainFromHostTLS(url);
	}

	parsed.host = foundHostCache[updateKey];

	return parsed.toString();
}
