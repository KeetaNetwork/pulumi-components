import { execSync } from 'child_process';

const foundHostCache: { [key: string]: string } = {};

function getAndAddDomainFromHostTLS(url: string) {
	const parsed = new URL(url);

	const starttls = parsed.protocol.split(':')[0];

	const foundDomainResp = execSync(`echo '' | openssl s_client -connect ${parsed.host} -starttls ${starttls} 2>/dev/null | openssl x509 -ext subjectAltName -noout | awk '/DNS:/{ sub(/[[:space:]]*DNS:/, ""); print; }'`);
	const foundDomain = foundDomainResp.toString().trim();

	if (!foundDomain || foundDomain === '') {
		throw new Error('Could not find domain from TLS certificate');
	}

	execSync(`echo '${parsed.hostname} ${foundDomain} # Added Automatically by @keetapay/pulumi-components' | tee -a /etc/hosts`);

	return foundDomain;
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
