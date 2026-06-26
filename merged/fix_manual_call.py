with open('modules/pipeline.js', 'r', encoding='utf-8') as f:
    c = f.read()

# Manual calls should process results even when pipeline is disabled
c = c.replace(
    'if (!this.enabled) { console.log("processCompletedCalls: disabled"); return; }',
    'if (!this.enabled && !this.queue.some(q => q.status === \'calling\')) return;'
)

with open('modules/pipeline.js', 'w', encoding='utf-8') as f:
    f.write(c)

import subprocess
r = subprocess.run(['node', '-c', 'modules/pipeline.js'], capture_output=True, text=True)
print(r.stderr or 'Syntax OK')
