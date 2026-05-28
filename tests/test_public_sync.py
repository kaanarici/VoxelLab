import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_public_repo", ROOT / "scripts" / "sync_public_repo.py")
sync_public_repo = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_public_repo)


def test_public_export_sanitizes_provider_config_and_sync_scripts(tmp_path):
    (tmp_path / "config.json").write_text(
        json.dumps(
            {
                "modalWebhookBase": "https://modal.example",
                "r2PublicUrl": "https://r2.example",
                "trustedUploadOrigins": ["https://upload.example"],
                "modalAuthToken": "secret",
                "localApiToken": "local",
                "siteName": "Private VoxelLab",
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "scripts": {
                    "check": "npm run lint:ci && npm run test:python",
                    "sync:public": "node scripts/run_python.mjs scripts/sync_public_repo.py --publish",
                    "sync:public:export": "node scripts/run_python.mjs scripts/sync_public_repo.py",
                }
            }
        ),
        encoding="utf-8",
    )

    sync_public_repo.sanitize_config(tmp_path)
    sync_public_repo.sanitize_package_json(tmp_path)

    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    package = json.loads((tmp_path / "package.json").read_text(encoding="utf-8"))

    assert config["modalWebhookBase"] == ""
    assert config["r2PublicUrl"] == ""
    assert config["trustedUploadOrigins"] == []
    assert config["siteName"] == "VoxelLab"
    assert "modalAuthToken" not in config
    assert "localApiToken" not in config
    assert "sync:public" not in package["scripts"]
    assert "sync:public:export" not in package["scripts"]


def test_public_export_prunes_optional_source_demo_files(tmp_path):
    demo_sources = tmp_path / "demo_sources" / "ome_microscopy_samples"
    demo_sources.mkdir(parents=True)
    _ = (demo_sources / "single-channel.ome.tif").write_bytes(b"sample")

    sync_public_repo.prune_export(tmp_path)

    assert not (tmp_path / "demo_sources").exists()
    sync_public_repo.assert_public_export_clean(tmp_path)
