FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-paramiko openssh-server openssh-client supervisor acl procps passwd systemd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /etc/supervisor/conf.d /var/lib/workbench-probe \
    && useradd -M -s /bin/bash issue5_keeper \
    && printf 'issue5_keeper:fixture-keeper-password\n' | chpasswd
WORKDIR /opt/workbench
COPY server server
COPY tests tests
COPY src/admin/connection.ts src/admin/connection.ts
COPY tests/integration/non-systemd/sshd.conf /etc/supervisor/conf.d/sshd.conf
COPY tests/integration/non-systemd/start.sh /opt/workbench/start.sh
RUN chmod 0755 /opt/workbench/start.sh
ENTRYPOINT ["/bin/bash", "/opt/workbench/start.sh"]
