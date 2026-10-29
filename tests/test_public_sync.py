import importlib.util
import json
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_public_repo", ROOT / "scripts" / "sync_public_repo.py")
sync_public_repo = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_public_repo)

SOURCE_PACKAGE_SCRIPTS = {
    "check": "npm run lint:ci && npm run test:python",
    "check:fast": "node scripts/run_checks.mjs test:python lint:ci check:validation test:node check:reference-parity",
    "check:lab": "node scripts/check_lab_readiness.mjs",
    "check:py:types": "node scripts/run_python.mjs -m basedpyright",
    "check:py:types:boundaries": "node scripts/run_python.mjs -m basedpyright -p pyright.boundaries.json",
    "desktop:smoke:packaged:mac": "node scripts/check_packaged_electron_app.mjs out/forge",
    "desktop:smoke:packaged:win": "node scripts/check_packaged_electron_app.mjs out/forge",
    "desktop:smoke:release:mac": "node scripts/check_macos_release_artifacts.mjs out/forge/make",
    "desktop:ensure-electron": "node scripts/ensure_electron_runtime.mjs",
    "desktop:smoke": "npm run desktop:ensure-electron && node --test --test-concurrency=1 tests/electron-runtime-smoke.mjs",
    "desktop:check": "node scripts/check_electron_desktop.mjs && node scripts/check_release_workflow.mjs",
    "sync:public": "node scripts/run_python.mjs scripts/sync_public_repo.py --publish",
    "sync:public:export": "node scripts/run_python.mjs scripts/sync_public_repo.py",
}
PRIVATE_ONLY_SCRIPTS = {"sync:public", "sync:public:export", "check:py:types", "check:py:types:boundaries"}

def empty_public_data(root: Path) -> Path:
    data_dir = root / "data"
    data_dir.mkdir(exist_ok=True)
    _ = (data_dir / "manifest.json").write_text(
        json.dumps(sync_public_repo.EMPTY_PUBLIC_MANIFEST),
        encoding="utf-8",
    )
    return data_dir

def git(*args: str, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()

def init_repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    _ = subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
    _ = subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    _ = subprocess.run(["git", "config", "user.name", "VoxelLab Test"], cwd=root, check=True)
    return root

def test_export_contract_stays_auditable_and_free_of_stale_entries():
    protected = {
        "scripts/sync_public_repo.py",
        "--exclude=scripts/sync_public_repo.py",
        "plans",
        "--exclude=plans/",
        "--include=/data/",
        "--include=/data/manifest.json",
        "--exclude=/data/***",
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

def test_sanitized_config_publishes_no_provider_endpoints_or_secrets(tmp_path):
    _ = (tmp_path / "config.json").write_text(
        json.dumps({
            "modalWebhookBase": "https://modal.example",
            "r2PublicUrl": "https://r2.example",
            "trustedUploadOrigins": ["https://upload.example"],
            "modalAuthToken": "secret",
            "localApiToken": "local",
            "siteName": "Private VoxelLab",
            "disclaimer": "Base disclaimer",
            "features": {"cloudProcessing": True, "aiAnalysis": True},
        }),
        encoding="utf-8",
    )

    sync_public_repo.sanitize_config(tmp_path)

    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert config["modalWebhookBase"] == ""
    assert config["r2PublicUrl"] == ""
    assert config["trustedUploadOrigins"] == []
    assert config["siteName"] == "VoxelLab"
    assert config["features"] == {"cloudProcessing": False, "aiAnalysis": False}
    assert "modalAuthToken" not in config
    assert "localApiToken" not in config
    assert "secret" not in json.dumps(config)

def test_sanitized_package_drops_private_scripts_and_keeps_desktop_proof(tmp_path):
    _ = (tmp_path / "package.json").write_text(
        json.dumps({"scripts": dict(SOURCE_PACKAGE_SCRIPTS)}),
        encoding="utf-8",
    )

    sync_public_repo.sanitize_package_json(tmp_path)

    scripts = json.loads((tmp_path / "package.json").read_text(encoding="utf-8"))["scripts"]
    rewritten = {"check", "check:fast", "check:lab"}
    assert set(scripts) == set(SOURCE_PACKAGE_SCRIPTS) - PRIVATE_ONLY_SCRIPTS
    assert scripts["check:lab"] == (
        "node scripts/check_lab_readiness.mjs --skip-validation-matrix --skip-public-export --skip-demo-pack --skip-converters --skip-browser"
    )
    assert scripts["check"] == "npm run lint:ci"
    assert scripts["check:fast"] == "node scripts/run_checks.mjs lint:ci test:node"
    unchanged = {
        name: command
        for name, command in SOURCE_PACKAGE_SCRIPTS.items()
        if name in scripts and name not in rewritten
    }
    assert {name: scripts[name] for name in unchanged} == unchanged

def test_a_real_export_keeps_desktop_release_proof_and_drops_private_paths(tmp_path):
    export_dir = tmp_path / "public"

    _ = subprocess.run(
        ["node", "scripts/run_python.mjs", "scripts/sync_public_repo.py", "--dest", str(export_dir)],
        cwd=ROOT,
        check=True,
    )

    scripts = json.loads((export_dir / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts["desktop:smoke:packaged:mac"] == "node scripts/check_packaged_electron_app.mjs out/forge"
    assert scripts["desktop:smoke:packaged:win"] == "node scripts/check_packaged_electron_app.mjs out/forge"
    assert scripts["desktop:smoke:release:mac"] == "node scripts/check_macos_release_artifacts.mjs out/forge/make"
    assert scripts["desktop:ensure-electron"] == "node scripts/ensure_electron_runtime.mjs"
    for present in (
        "scripts/check_packaged_electron_app.mjs",
        "scripts/ensure_electron_runtime.mjs",
        "scripts/check_macos_release_artifacts.mjs",
        "electron/entitlements/darwin-main.plist",
        "electron/entitlements/darwin-helper.plist",
        ".github/assets/voxellab-viewer.jpg",
        ".github/ISSUE_TEMPLATE/bug_report.yml",
        ".github/ISSUE_TEMPLATE/feature_request.yml",
        ".github/ISSUE_TEMPLATE/config.yml",
    ):
        assert (export_dir / present).exists(), present
    for absent in ("scripts/sync_public_repo.py", "MISSION.md", "plans", "tests/documentation-check.test.mjs"):
        assert not (export_dir / absent).exists(), absent
    sync_public_repo.assert_public_export_clean(export_dir)

def test_pruning_removes_optional_sources_and_local_readiness_reports(tmp_path):
    for relative in (
        "demo_sources/ome_microscopy_samples/single-channel.ome.tif",
        "test-samples/microscopy/sample.nd2",
    ):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_bytes(b"sample")
    for report in ("lab-readiness-report.json", "lab-readiness-report-public.json"):
        _ = (tmp_path / report).write_text('{"status":"passed"}\n', encoding="utf-8")
    _ = empty_public_data(tmp_path)

    sync_public_repo.prune_export(tmp_path)

    for removed in ("demo_sources", "test-samples", "lab-readiness-report.json", "lab-readiness-report-public.json"):
        assert not (tmp_path / removed).exists(), removed
    sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_rejects_patient_data_in_the_data_directory(tmp_path):
    data_dir = empty_public_data(tmp_path)
    _ = (data_dir / "patient-scan.dcm").write_bytes(b"dicom")

    with pytest.raises(RuntimeError, match="data directory must contain only"):
        sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_rejects_a_non_anonymous_manifest(tmp_path):
    data_dir = empty_public_data(tmp_path)
    _ = (data_dir / "manifest.json").write_text(
        json.dumps({"patient": "real", "series": [{"id": "scan"}]}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="manifest.json must stay anonymous"):
        sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_allows_the_allowlisted_synthetic_dicom_fixtures(tmp_path):
    _ = empty_public_data(tmp_path)
    for relative in sync_public_repo.SYNTHETIC_IMAGING_FIXTURE_SHA256:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = target.write_bytes((ROOT / relative).read_bytes())

    sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_rejects_a_modified_allowlisted_dicom_fixture(tmp_path):
    _ = empty_public_data(tmp_path)
    canonical_rel = next(iter(sync_public_repo.SYNTHETIC_IMAGING_FIXTURE_SHA256))
    target = tmp_path / canonical_rel
    target.parent.mkdir(parents=True, exist_ok=True)
    _ = target.write_bytes(b"content no longer matches the synthetic fixture")

    with pytest.raises(RuntimeError, match=canonical_rel):
        sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_rejects_a_dicom_that_is_not_allowlisted(tmp_path):
    _ = empty_public_data(tmp_path)
    leaked = tmp_path / "tests" / "real-patient.dcm"
    leaked.parent.mkdir(parents=True, exist_ok=True)
    _ = leaked.write_bytes(b"not an allowlisted synthetic fixture")

    with pytest.raises(RuntimeError, match="tests/real-patient.dcm"):
        sync_public_repo.assert_public_export_clean(tmp_path)

def test_export_check_reports_every_private_runtime_path_it_finds(tmp_path):
    _ = empty_public_data(tmp_path)
    forbidden_paths = [
        ".env.local",
        "config.local.json",
        ".codex/session.json",
        ".playwright-mcp/state.json",
        "MISSION.md",
        "plans/private-release-plan.md",
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
    for relative in forbidden_paths:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text("private\n", encoding="utf-8")

    with pytest.raises(RuntimeError) as exc_info:
        sync_public_repo.assert_public_export_clean(tmp_path)

    message = str(exc_info.value)
    for reported in (
        ".env.local",
        "config.local.json",
        ".codex",
        ".playwright-mcp",
        "MISSION.md",
        "plans",
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
    ):
        assert reported in message, reported

def test_public_checkout_must_match_remote_main(tmp_path, monkeypatch):
    calls = []
    outputs = {
        ("git", "status", "--porcelain"): "",
        ("git", "branch", "--show-current"): "main",
        ("git", "rev-parse", "HEAD"): "local-id",
        ("git", "rev-parse", "refs/remotes/origin/main"): "remote-id",
    }

    def fake_output(cmd, cwd=None):
        if tuple(cmd) in outputs:
            return outputs[tuple(cmd)]
        raise AssertionError(f"unexpected output command: {cmd}")

    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(sync_public_repo, "public_remote", lambda dest: "git@example.com:kaanarici/VoxelLab.git")
    monkeypatch.setattr(sync_public_repo, "run", lambda cmd, cwd=None, env=None: calls.append((cmd, cwd, env)))
    monkeypatch.setattr(sync_public_repo, "output", fake_output)

    with pytest.raises(RuntimeError, match="must exactly match origin/main"):
        sync_public_repo.prepare_public_checkout(tmp_path)

    assert (["git", "fetch", "origin", "main"], tmp_path, None) in calls

def test_public_history_appends_a_normal_commit(tmp_path):
    repo = init_repo(tmp_path)
    _ = (repo / "public.txt").write_text("old\n", encoding="utf-8")
    _ = subprocess.run(["git", "add", "public.txt"], cwd=repo, check=True)
    _ = subprocess.run(["git", "commit", "-m", "old history"], cwd=repo, check=True, capture_output=True)
    previous = git("rev-parse", "HEAD", cwd=repo)
    _ = (repo / "public.txt").write_text("new\n", encoding="utf-8")

    assert sync_public_repo.commit_public_export(repo, "Explain the public change") is True

    assert git("rev-list", "--count", "HEAD", cwd=repo) == "2"
    assert git("rev-parse", "HEAD^", cwd=repo) == previous
    assert git("log", "-1", "--format=%s", cwd=repo) == "Explain the public change"
    assert git("status", "--porcelain", cwd=repo) == ""

def test_public_export_pr_uses_a_unique_source_bound_branch(tmp_path, monkeypatch):
    calls = []
    branch = "public-sync/v1.1.2-source123"

    def fake_output(cmd, cwd=None):
        if cmd[:3] == ["git", "branch", "--list"] or cmd[:3] == ["git", "ls-remote", "--heads"]:
            return ""
        if cmd == ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]:
            return "kaanarici/VoxelLab"
        if cmd[:3] == ["gh", "pr", "create"]:
            return "https://github.com/kaanarici/VoxelLab/pull/1"
        if cmd == ["git", "branch", "--show-current"]:
            return branch
        raise AssertionError(f"unexpected output command: {cmd}")

    monkeypatch.setattr(sync_public_repo, "public_sync_branch_name", lambda: branch)
    monkeypatch.setattr(sync_public_repo, "commit_public_export", lambda dest, message: True)
    monkeypatch.setattr(sync_public_repo, "run", lambda cmd, cwd=None, env=None: calls.append(cmd))
    monkeypatch.setattr(sync_public_repo, "output", fake_output)

    url = sync_public_repo.open_public_export_pr(tmp_path, "Update public export")

    assert url == "https://github.com/kaanarici/VoxelLab/pull/1"
    assert ["git", "switch", "-c", branch] in calls
    assert ["git", "push", "--set-upstream", "origin", branch] in calls
    assert calls[-1] == ["git", "switch", "main"]

def test_publishing_requires_a_clean_source_checkout(tmp_path, monkeypatch):
    source = init_repo(tmp_path / "source")
    _ = (source / "tracked.txt").write_text("clean\n", encoding="utf-8")
    _ = subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)
    _ = subprocess.run(["git", "commit", "-m", "initial"], cwd=source, check=True, capture_output=True)
    _ = (source / "tracked.txt").write_text("dirty\n", encoding="utf-8")
    monkeypatch.setattr(sync_public_repo, "ROOT", source)

    with pytest.raises(RuntimeError, match="dirty source checkout"):
        sync_public_repo.assert_source_checkout_clean()

def test_publishing_rechecks_the_export_after_the_public_checks_run(tmp_path, monkeypatch):
    calls = []

    def dirty_prune(dest):
        generated_docs = dest / "docs"
        generated_docs.mkdir(exist_ok=True)
        _ = (generated_docs / "generated.md").write_text("private planning output\n", encoding="utf-8")
        _ = empty_public_data(dest)

    monkeypatch.setattr(sync_public_repo, "public_remote", lambda dest: "git@example.com:kaanarici/VoxelLab.git")
    monkeypatch.setattr(sync_public_repo, "free_local_port", lambda: 4173)
    monkeypatch.setattr(sync_public_repo, "run", lambda cmd, cwd=None, env=None: calls.append(cmd))
    monkeypatch.setattr(sync_public_repo, "prune_export", dirty_prune)

    with pytest.raises(RuntimeError, match="public export still contains forbidden paths"):
        sync_public_repo.publish_export(tmp_path)

    assert ["npm", "run", "check"] in calls
    assert ["npm", "run", "check:lab"] in calls

def test_publishing_rewrites_public_data_after_the_checks_and_opens_a_pull_request(tmp_path, monkeypatch):
    calls = []
    data_dir = empty_public_data(tmp_path)

    def fake_run(cmd, cwd=None, env=None):
        calls.append(cmd)
        if cmd == ["npm", "run", "check:lab"]:
            _ = (data_dir / "patient-scan.dcm").write_bytes(b"dicom")
            _ = (data_dir / "manifest.json").write_text(
                json.dumps({"patient": "real", "series": [{"id": "scan"}]}),
                encoding="utf-8",
            )

    monkeypatch.setattr(sync_public_repo, "public_remote", lambda dest: "git@example.com:kaanarici/VoxelLab.git")
    monkeypatch.setattr(sync_public_repo, "free_local_port", lambda: 4173)
    monkeypatch.setattr(sync_public_repo, "MACOS_TRASH", tmp_path / "missing-trash-command")
    monkeypatch.setattr(sync_public_repo, "run", fake_run)
    monkeypatch.setattr(
        sync_public_repo,
        "open_public_export_pr",
        lambda dest, message: calls.append(["open-public-export-pr", message]) or "https://github.com/kaanarici/VoxelLab/pull/1",
    )
    monkeypatch.setattr(
        sync_public_repo,
        "output",
        lambda cmd, cwd=None: "changed.txt" if cmd == ["git", "diff", "--cached", "--name-only"] else "",
    )

    sync_public_repo.publish_export(tmp_path)

    assert sorted(path.name for path in data_dir.iterdir()) == ["manifest.json"]
    assert json.loads((data_dir / "manifest.json").read_text(encoding="utf-8")) == sync_public_repo.EMPTY_PUBLIC_MANIFEST
    assert ["npm", "run", "check"] in calls
    assert ["npm", "run", "check:lab"] in calls
    assert ["open-public-export-pr", "Update public export"] in calls
    assert ["git", "push", "origin", "main"] not in calls
