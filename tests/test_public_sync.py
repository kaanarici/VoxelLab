import importlib.util
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_public_repo", ROOT / "scripts" / "sync_public_repo.py")
sync_public_repo = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_public_repo)


def test_public_export_sync_script_exclusions_stay_auditable():
    protected = {
        "scripts/sync_public_repo.py",
        "--exclude=scripts/sync_public_repo.py",
    }
    stale = {
        "scripts/sync_public_export.py",
        "--exclude=scripts/sync_public_export.py",
    }
    export_contract = (
        set(sync_public_repo.EXCLUDE_ARGS)
        | set(sync_public_repo.REMOVE_PATHS)
        | set(sync_public_repo.FORBIDDEN_EXPORT_PATHS)
    )

    assert protected.issubset(export_contract)
    assert export_contract.isdisjoint(stale)


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
                "features": {"cloudProcessing": True, "aiAnalysis": True},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "scripts": {
                    "check": "npm run lint:ci && npm run test:python",
                    "check:lab": "node scripts/check_lab_readiness.mjs",
                    "desktop:smoke:packaged:mac": "node scripts/check_packaged_electron_app.mjs out/forge",
                    "desktop:smoke:release:mac": "node scripts/check_macos_release_artifacts.mjs out/forge/make",
                    "desktop:ensure-electron": "node scripts/ensure_electron_runtime.mjs",
                    "desktop:smoke": "npm run desktop:ensure-electron && node --test --test-concurrency=1 tests/electron-runtime-smoke.mjs tests/electron-nifti-smoke.mjs tests/electron-tiff-sequence-smoke.mjs tests/electron-microscopy-workflow-smoke.mjs",
                    "desktop:check": "node scripts/check_electron_desktop.mjs && node scripts/check_electron_package.mjs && node scripts/check_release_workflow.mjs && node --test tests/electron-desktop-contract.test.mjs && npm run desktop:smoke",
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
    assert config["features"]["cloudProcessing"] is False
    assert config["features"]["aiAnalysis"] is False
    assert "modalAuthToken" not in config
    assert "localApiToken" not in config
    assert package["scripts"]["check:lab"] == "node scripts/check_lab_readiness.mjs --skip-validation-matrix --skip-public-export --skip-demo-pack --skip-converters --skip-browser"
    assert package["scripts"]["desktop:smoke:packaged:mac"] == "node scripts/check_packaged_electron_app.mjs out/forge"
    assert package["scripts"]["desktop:smoke:release:mac"] == "node scripts/check_macos_release_artifacts.mjs out/forge/make"
    assert package["scripts"]["desktop:ensure-electron"] == "node scripts/ensure_electron_runtime.mjs"
    assert package["scripts"]["desktop:smoke"] == "npm run desktop:ensure-electron && node --test --test-concurrency=1 tests/electron-runtime-smoke.mjs tests/electron-nifti-smoke.mjs tests/electron-tiff-sequence-smoke.mjs tests/electron-microscopy-workflow-smoke.mjs"
    assert "check_release_workflow.mjs" in package["scripts"]["desktop:check"]
    assert "sync:public" not in package["scripts"]
    assert "sync:public:export" not in package["scripts"]


def test_public_export_preserves_desktop_release_proof_files(tmp_path):
    export_dir = tmp_path / "public"

    _ = subprocess.run(
        ["node", "scripts/run_python.mjs", "scripts/sync_public_repo.py", "--dest", str(export_dir)],
        cwd=ROOT,
        check=True,
    )

    package = json.loads((export_dir / "package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]

    assert scripts["desktop:smoke:packaged:mac"] == "node scripts/check_packaged_electron_app.mjs out/forge"
    assert scripts["desktop:smoke:release:mac"] == "node scripts/check_macos_release_artifacts.mjs out/forge/make"
    assert scripts["desktop:ensure-electron"] == "node scripts/ensure_electron_runtime.mjs"
    assert (export_dir / "scripts" / "check_packaged_electron_app.mjs").exists()
    assert (export_dir / "scripts" / "ensure_electron_runtime.mjs").exists()
    assert (export_dir / "scripts" / "check_macos_release_artifacts.mjs").exists()
    assert (export_dir / "electron" / "entitlements" / "darwin-main.plist").exists()
    assert (export_dir / "electron" / "entitlements" / "darwin-helper.plist").exists()
    assert not (export_dir / "scripts" / "sync_public_repo.py").exists()
    assert not (export_dir / "MISSION.md").exists()
    sync_public_repo.assert_public_export_clean(export_dir)


def test_public_export_prunes_optional_source_demo_files(tmp_path):
    demo_sources = tmp_path / "demo_sources" / "ome_microscopy_samples"
    demo_sources.mkdir(parents=True)
    _ = (demo_sources / "single-channel.ome.tif").write_bytes(b"sample")
    test_samples = tmp_path / "test-samples" / "microscopy"
    test_samples.mkdir(parents=True)
    _ = (test_samples / "sample.nd2").write_bytes(b"sample")
    (tmp_path / "lab-readiness-report.json").write_text('{"status":"passed"}\n', encoding="utf-8")
    (tmp_path / "lab-readiness-report-public.json").write_text('{"status":"passed"}\n', encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "manifest.json").write_text(json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST), encoding="utf-8")

    sync_public_repo.prune_export(tmp_path)

    assert not (tmp_path / "demo_sources").exists()
    assert not (tmp_path / "test-samples").exists()
    assert not (tmp_path / "lab-readiness-report.json").exists()
    assert not (tmp_path / "lab-readiness-report-public.json").exists()
    sync_public_repo.assert_public_export_clean(tmp_path)


def test_public_export_clean_rejects_patient_data_or_nonanonymous_manifest(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "manifest.json").write_text(json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST), encoding="utf-8")
    (data_dir / "patient-scan.dcm").write_bytes(b"dicom")

    try:
        sync_public_repo.assert_public_export_clean(tmp_path)
    except RuntimeError as exc:
        assert "data directory must contain only" in str(exc)
    else:
        raise AssertionError("expected patient data in public export to be rejected")

    (data_dir / "patient-scan.dcm").unlink()
    (data_dir / "manifest.json").write_text(json.dumps({"patient": "real", "series": [{"id": "scan"}]}), encoding="utf-8")

    try:
        sync_public_repo.assert_public_export_clean(tmp_path)
    except RuntimeError as exc:
        assert "manifest.json must stay anonymous" in str(exc)
    else:
        raise AssertionError("expected non-anonymous manifest to be rejected")


def test_public_export_clean_rejects_private_runtime_paths(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "manifest.json").write_text(json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST), encoding="utf-8")
    forbidden_paths = [
        ".env.local",
        "config.local.json",
        ".codex/session.json",
        ".playwright-mcp/state.json",
        "MISSION.md",
        ".vercel/project.json",
        "test-results/report.json",
        "test-samples/microscopy/sample.nd2",
        "lab-readiness-report.json",
        "lab-readiness-report-public.json",
        "scripts/sync_public_repo.py",
        "nested/.flow.yaml",
        "nested/__pycache__/module.pyc",
        "nested/voxellab_tooling.egg-info/PKG-INFO",
        "private.raw.zst",
        "scan.nii.gz",
    ]
    for rel in forbidden_paths:
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("private\n", encoding="utf-8")

    try:
        sync_public_repo.assert_public_export_clean(tmp_path)
    except RuntimeError as exc:
        message = str(exc)
        expected_reports = [
            ".env.local",
            "config.local.json",
            ".codex",
            ".playwright-mcp",
            "MISSION.md",
            ".vercel",
            "test-results",
            "test-samples",
            "lab-readiness-report.json",
            "lab-readiness-report-public.json",
            "scripts/sync_public_repo.py",
            "nested/.flow.yaml",
            "nested/__pycache__",
            "nested/voxellab_tooling.egg-info",
            "private.raw.zst",
            "scan.nii.gz",
        ]
        for rel in expected_reports:
            assert rel in message
    else:
        raise AssertionError("expected private runtime paths to be rejected")


def test_public_history_uses_exact_root_commit_message(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, cwd=None, env=None):
        calls.append((cmd, cwd, env))

    monkeypatch.setattr(sync_public_repo, "run", fake_run)

    sync_public_repo.init_public_history(tmp_path, "git@example.com:kaanarici/VoxelLab.git")

    assert (["git", "commit", "-m", "initial commit"], tmp_path, None) in calls
    assert not any(call[0] == ["git", "commit", "-m", "Initial commit"] for call in calls)


def test_public_publish_requires_clean_source_checkout(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    _ = subprocess.run(["git", "init", "-b", "main"], cwd=source, check=True)
    _ = subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    _ = subprocess.run(["git", "config", "user.name", "VoxelLab Test"], cwd=source, check=True)
    (source / "tracked.txt").write_text("clean\n", encoding="utf-8")
    _ = subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)
    _ = subprocess.run(["git", "commit", "-m", "initial"], cwd=source, check=True)
    (source / "tracked.txt").write_text("dirty\n", encoding="utf-8")
    monkeypatch.setattr(sync_public_repo, "ROOT", source)

    try:
        sync_public_repo.assert_source_checkout_clean()
    except RuntimeError as exc:
        assert "dirty source checkout" in str(exc)
    else:
        raise AssertionError("expected dirty source checkout to block public publish")


def test_public_publish_rechecks_export_after_public_check(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, cwd=None, env=None):
        calls.append(cmd)

    def dirty_prune(dest):
        generated_docs = dest / "docs"
        generated_docs.mkdir(exist_ok=True)
        (generated_docs / "generated.md").write_text("private planning output\n", encoding="utf-8")
        generated_data = dest / "data"
        generated_data.mkdir(exist_ok=True)
        (generated_data / "manifest.json").write_text(json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST), encoding="utf-8")

    monkeypatch.setattr(sync_public_repo, "public_remote", lambda dest: "git@example.com:kaanarici/VoxelLab.git")
    monkeypatch.setattr(sync_public_repo, "run", fake_run)
    monkeypatch.setattr(sync_public_repo, "prune_export", dirty_prune)
    monkeypatch.setattr(sync_public_repo, "init_public_history", lambda dest, remote: calls.append(["init-public-history"]))

    try:
        sync_public_repo.publish_export(tmp_path)
    except RuntimeError as exc:
        assert "public export still contains forbidden paths" in str(exc)
    else:
        raise AssertionError("expected post-check public export assertion to block publish")

    assert ["npm", "run", "check"] in calls
    assert ["npm", "run", "check:lab"] in calls
    assert ["init-public-history"] not in calls


def test_public_publish_rewrites_public_data_after_checks(tmp_path, monkeypatch):
    calls = []
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "manifest.json").write_text(json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST), encoding="utf-8")

    def fake_run(cmd, cwd=None, env=None):
        calls.append(cmd)
        if cmd == ["npm", "run", "check:lab"]:
            (data_dir / "patient-scan.dcm").write_bytes(b"dicom")
            (data_dir / "manifest.json").write_text(json.dumps({"patient": "real", "series": [{"id": "scan"}]}), encoding="utf-8")

    monkeypatch.setattr(sync_public_repo, "public_remote", lambda dest: "git@example.com:kaanarici/VoxelLab.git")
    monkeypatch.setattr(sync_public_repo, "run", fake_run)
    monkeypatch.setattr(sync_public_repo, "init_public_history", lambda dest, remote: calls.append(["init-public-history"]))

    sync_public_repo.publish_export(tmp_path)

    assert sorted(path.name for path in data_dir.iterdir()) == ["manifest.json"]
    assert json.loads((data_dir / "manifest.json").read_text(encoding="utf-8")) == sync_public_repo.EMPTY_PUBLIC_MANIFEST
    assert ["npm", "run", "check"] in calls
    assert ["npm", "run", "check:lab"] in calls
    assert ["init-public-history"] in calls
