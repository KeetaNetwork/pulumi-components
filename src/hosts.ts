import { execSync } from 'child_process';
import { X509Certificate } from 'crypto';

const foundHostCache: { [key: string]: string } = {};

const maxAttempts = 5;

/**
 * Get the Subject Alternative Name from the TLS certificate
 * that a TLS Server presents when you connect to it
 */
function getHostSAN(url: URL) {
	const protocol = url.protocol.split(':')[0];

	let startTLSCommand: string;
	let connectTo: string;
	switch (protocol) {
		case 'https':
			startTLSCommand = '';
			connectTo = `${url.hostname}:${url.port || 443}`;
			break;
		default:
			startTLSCommand = `-starttls ${protocol}`;
			connectTo = url.host;
			break;
	}

	let error;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const foundCert = execSync(`echo '' | openssl s_client -connect ${connectTo} ${startTLSCommand} 2>/dev/null | openssl x509`).toString('utf8');
			const cert = new X509Certificate(foundCert);
			const foundDomain = cert.subjectAltName?.replace(/, .*$/, '').replace(/^DNS:/, '');

			if (!foundDomain || foundDomain === '') {
				throw new Error('Could not find domain from TLS certificate');
			}

			return foundDomain;
		} catch (e) {
			error = e;
		}
	}

	throw error;
}

/**
 * Get and add the domain from the TLS certificate to the hosts file
 * Note: This only works when the protocols that use starttls or https
 */
function getAndAddDomainFromHostTLS(url: string) {
	const parsed = new URL(url);

	const foundDomain = getHostSAN(parsed);

	execSync(`echo '${parsed.hostname} ${foundDomain} # Added Automatically by @keetapay/pulumi-components' | tee -a /etc/hosts`);

	return(foundDomain);
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
