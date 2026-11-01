# Lightinator Log Service add-on

This add-on runs the published Lightinator Log Service container with host
networking, so controllers can send syslog over UDP and the service can announce
itself via mDNS. Service data and configuration are stored persistently under
the add-on configuration directory.

Use **Open Web UI** on the add-on page to access the frontend. The service is
available on TCP port 4821 and receives controller syslog on UDP port 5514.
Keep those service ports at their defaults so the add-on's web link and watchdog
continue to work.