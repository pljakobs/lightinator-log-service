const { Bonjour } = require("bonjour-service");

function advertiseMdns({ serviceName, httpPort, udpPort, mdnsHost }) {
  const bonjour = new Bonjour();

  const httpService = bonjour.publish({
    name: serviceName,
    type: "lightinator-log",
    protocol: "tcp",
    port: httpPort,
    host: mdnsHost,
    txt: {
      api_version: "1",
      service: "LightinatorLogService",
      http_port: String(httpPort),
      syslog_port: String(udpPort),
    },
  });

  const udpService = bonjour.publish({
    name: `${serviceName} Syslog`,
    type: "lightinator-syslog",
    protocol: "udp",
    port: udpPort,
    host: mdnsHost,
    txt: {
      service: "LightinatorLogService",
      role: "syslog-ingest",
    },
  });

  return {
    info: {
      host: mdnsHost,
      services: [
        {
          name: serviceName,
          type: "_lightinator-log._tcp.local",
          port: httpPort,
        },
        {
          name: `${serviceName} Syslog`,
          type: "_lightinator-syslog._udp.local",
          port: udpPort,
        },
      ],
    },
    stop: () => {
      try {
        httpService.stop();
        udpService.stop();
        bonjour.destroy();
      } catch (_err) {
        // Ignore shutdown errors.
      }
    },
  };
}

module.exports = { advertiseMdns };
