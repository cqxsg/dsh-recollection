"""Extract only verified Rust component archives, without PATH-dependent xz."""
import pathlib
import sys
import tarfile

archive, root, prefix = sys.argv[1:]
base = pathlib.Path(root).resolve()
with tarfile.open(archive, "r:xz") as source:
    members = source.getmembers()
    for member in members:
        target = (base / member.name).resolve()
        if ((member.name != prefix and not member.name.startswith(prefix + "/")) or base not in target.parents
                or member.issym() or member.islnk()
                or not (member.isfile() or member.isdir())):
            raise ValueError("Unsafe Rust archive member: " + member.name)
    source.extractall(base, members=members)
